"""Plain-text extraction from uploaded contract documents.

Supported: ``.txt``, ``.pdf`` (via pypdf) and ``.docx`` (stdlib zip + XML).
Images are rejected explicitly: OCR is not performed, so no text is invented.

All parsers are defensive: archive members and output are size-capped, XML
with a DOCTYPE is refused (no entity expansion / XXE), and parser errors are
reported as :class:`TextExtractionError` with a user-safe message.
"""

import io
import time
import re
import zipfile
from xml.etree import ElementTree

MAX_OUTPUT_CHARS = 2_000_000
MAX_PDF_PAGES = 200
PDF_TIME_BUDGET_SECONDS = 20.0
MAX_DOCX_XML_BYTES = 50 * 1024 * 1024

IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".tif", ".tiff", ".bmp", ".webp"}
SUPPORTED_EXTENSIONS = {".txt", ".pdf", ".docx"}

_W_NS = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


class TextExtractionError(ValueError):
    """The document's text could not be extracted."""


def _normalize_extension(extension: str) -> str:
    ext = (extension or "").strip().lower()
    if ext and not ext.startswith("."):
        ext = "." + ext
    return ext


def is_extractable(extension: str) -> bool:
    return _normalize_extension(extension) in SUPPORTED_EXTENSIONS


def _clean(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n").replace("\x00", "")
    text = re.sub(r"[ \t\f\v]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()[:MAX_OUTPUT_CHARS]


def _extract_txt(data: bytes) -> str:
    encodings = ("utf-16",) if data[:2] in (b"\xff\xfe", b"\xfe\xff") else ("utf-8-sig", "cp1252")
    for encoding in encodings:
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    return data.decode("latin-1")


def _extract_pdf(data: bytes) -> str:
    try:
        from pypdf import PdfReader
        from pypdf.errors import PdfReadError
    except ImportError as exc:  # pragma: no cover - dependency missing
        raise TextExtractionError("PDF text extraction is not available on this server") from exc

    try:
        reader = PdfReader(io.BytesIO(data), strict=False)
        if reader.is_encrypted:
            try:
                if not reader.decrypt(""):
                    raise TextExtractionError("The PDF is password protected")
            except TextExtractionError:
                raise
            except Exception as exc:  # noqa: BLE001
                raise TextExtractionError("The PDF is password protected") from exc
        parts: list[str] = []
        total = 0
        started = time.monotonic()
        for index, page in enumerate(reader.pages):
            if index >= MAX_PDF_PAGES:
                break
            if time.monotonic() - started > PDF_TIME_BUDGET_SECONDS:
                # Pathological content streams can take seconds per page (AF-04).
                raise TextExtractionError("The PDF is too complex to process in time")
            page_text = page.extract_text() or ""
            parts.append(page_text)
            total += len(page_text)
            if total > MAX_OUTPUT_CHARS:
                break
        return "\n\n".join(parts)
    except TextExtractionError:
        raise
    except (PdfReadError, ValueError, KeyError, TypeError, AttributeError, OSError) as exc:
        raise TextExtractionError("The PDF could not be read") from exc
    except Exception as exc:  # noqa: BLE001 - pypdf raises a wide range of errors
        raise TextExtractionError("The PDF could not be read") from exc


def _docx_paragraph_text(paragraph: ElementTree.Element) -> str:
    chunks: list[str] = []
    for node in paragraph.iter():
        if node.tag == f"{_W_NS}t" and node.text:
            chunks.append(node.text)
        elif node.tag == f"{_W_NS}tab":
            chunks.append("\t")
        elif node.tag in (f"{_W_NS}br", f"{_W_NS}cr"):
            chunks.append("\n")
    return "".join(chunks)


def _extract_docx(data: bytes) -> str:
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as exc:
        raise TextExtractionError("The DOCX file is not a valid archive") from exc
    with archive:
        try:
            info = archive.getinfo("word/document.xml")
        except KeyError as exc:
            raise TextExtractionError("The DOCX file has no document body") from exc
        if info.file_size > MAX_DOCX_XML_BYTES:
            raise TextExtractionError("The DOCX document body is too large to process")
        try:
            with archive.open(info) as handle:
                xml_bytes = handle.read(MAX_DOCX_XML_BYTES + 1)
        except (zipfile.BadZipFile, RuntimeError, OSError) as exc:
            raise TextExtractionError("The DOCX file could not be read") from exc
    if len(xml_bytes) > MAX_DOCX_XML_BYTES:
        raise TextExtractionError("The DOCX document body is too large to process")
    # defusedxml rejects any DTD (entity expansion / XXE) regardless of the
    # document's encoding; a byte-level check misses UTF-16 (audit AF-03).
    from defusedxml import DefusedXmlException
    from defusedxml.ElementTree import fromstring as safe_fromstring

    try:
        root = safe_fromstring(xml_bytes, forbid_dtd=True, forbid_entities=True,
                               forbid_external=True)
    except DefusedXmlException as exc:
        raise TextExtractionError("The DOCX file contains unsupported XML declarations") from exc
    except ElementTree.ParseError as exc:
        raise TextExtractionError("The DOCX document body is malformed") from exc
    paragraphs = [_docx_paragraph_text(p) for p in root.iter(f"{_W_NS}p")]
    return "\n".join(paragraphs)


def extract_text(data: bytes, extension: str) -> str:
    """Return the plain text of a document. Raises :class:`TextExtractionError`
    for unsupported types (including images) or unreadable content."""
    ext = _normalize_extension(extension)
    if ext in IMAGE_EXTENSIONS:
        raise TextExtractionError(
            "Text extraction is unsupported for images; upload a PDF, DOCX or TXT version "
            "of the contract to analyze it"
        )
    if not data:
        raise TextExtractionError("The document is empty")
    if ext == ".txt":
        raw = _extract_txt(data)
    elif ext == ".pdf":
        raw = _extract_pdf(data)
    elif ext == ".docx":
        raw = _extract_docx(data)
    else:
        raise TextExtractionError(f"Text extraction is not supported for '{ext or 'unknown'}' files")
    return _clean(raw)
