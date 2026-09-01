"""
detect_copy_type.py  –  called by Electron main process
Usage: python detect_copy_type.py <pdf_path> <page_num>
Outputs JSON: {"type": "original"|"duplicate"|"triplicate"|"unknown"}

Strategy:
  1. Render the requested PDF page to an image (pdf2image / pymupdf)
  2. Run YOLOv8 OCR-style detection OR use easyocr/pytesseract as fallback
     to locate the copy-type label visually (handles stamps, watermarks, headers)
  3. Return the detected type as JSON
"""

import sys
import json
import re

def detect_with_easyocr(img):
    import easyocr
    reader = easyocr.Reader(["en"], gpu=False, verbose=False)
    results = reader.readtext(img, detail=0)
    text = " ".join(results).lower()
    return text

def detect_with_tesseract(img):
    import pytesseract
    import numpy as np
    text = pytesseract.image_to_string(img).lower()
    return text

def render_page(pdf_path, page_num):
    """Render PDF page to numpy image array. page_num is 1-based."""
    try:
        import pymupdf as fitz  # pymupdf
        doc = fitz.open(pdf_path)
        page = doc[page_num - 1]
        mat = fitz.Matrix(2.0, 2.0)  # 2x zoom for better OCR
        pix = page.get_pixmap(matrix=mat)
        import numpy as np
        img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
        if pix.n == 4:
            img = img[:, :, :3]
        return img
    except ImportError:
        pass

    # fallback: pdf2image
    from pdf2image import convert_from_path
    pages = convert_from_path(pdf_path, dpi=200, first_page=page_num, last_page=page_num)
    import numpy as np
    return np.array(pages[0])

def classify_text(text):
    t = text.lower()
    if re.search(r'\btriplicate\b', t):
        return "triplicate"
    if re.search(r'\bduplicate\b', t):
        return "duplicate"
    if re.search(r'\boriginal\b', t):
        return "original"
    return "unknown"

def detect_with_yolo(img):
    """
    Use YOLOv8 with a custom-trained model if available,
    otherwise fall back to OCR-based detection.
    Model should be placed at: electron/models/copy_type.pt
    Classes: 0=original, 1=duplicate, 2=triplicate
    """
    import os
    model_path = os.path.join(os.path.dirname(__file__), "models", "copy_type.pt")
    if not os.path.exists(model_path):
        return None  # no custom model, use OCR fallback

    from ultralytics import YOLO
    model = YOLO(model_path)
    results = model(img, verbose=False)
    class_names = {0: "original", 1: "duplicate", 2: "triplicate"}
    best_conf = 0
    best_type = None
    for r in results:
        for box in r.boxes:
            cls = int(box.cls[0])
            conf = float(box.conf[0])
            if conf > best_conf and cls in class_names:
                best_conf = conf
                best_type = class_names[cls]
    return best_type  # None if nothing detected

def main():
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Usage: detect_copy_type.py <pdf_path> <page_num>"}))
        sys.exit(1)

    pdf_path = sys.argv[1]
    page_num = int(sys.argv[2])

    try:
        img = render_page(pdf_path, page_num)
    except Exception as e:
        print(json.dumps({"error": f"render failed: {e}"}))
        sys.exit(1)

    # 1. Try YOLO custom model first
    try:
        yolo_result = detect_with_yolo(img)
        if yolo_result:
            print(json.dumps({"type": yolo_result, "method": "yolo"}))
            return
    except Exception:
        pass

    # 2. Try EasyOCR (visual OCR – handles stamps/watermarks)
    try:
        text = detect_with_easyocr(img)
        result = classify_text(text)
        if result != "unknown":
            print(json.dumps({"type": result, "method": "easyocr"}))
            return
    except Exception:
        pass

    # 3. Try Tesseract
    try:
        text = detect_with_tesseract(img)
        result = classify_text(text)
        print(json.dumps({"type": result, "method": "tesseract"}))
        return
    except Exception:
        pass

    print(json.dumps({"type": "unknown", "method": "none"}))

if __name__ == "__main__":
    main()
