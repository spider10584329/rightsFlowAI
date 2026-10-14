"""Defences against hostile office documents (audit AF-02 / AF-03).

XLSX and DOCX files are ZIP archives of XML. Before any parser touches them we
check the archive's central directory, so a small upload can't inflate into
gigabytes (decompression bombs). XML entity expansion is blocked separately:
``defusedxml`` is installed (openpyxl uses it automatically) and DOCX text is
parsed with ``defusedxml`` with DTDs forbidden.
"""

import io
import zipfile

from app.core.errors import ValidationFailedError

MAX_ARCHIVE_MEMBERS = 2_000
MAX_UNCOMPRESSED_TOTAL = 200 * 1024 * 1024   # 200 MB across all members
MAX_MEMBER_RATIO = 100                       # uncompressed / compressed
RATIO_CHECK_MIN_SIZE = 1024 * 1024           # tiny members compress extremely well legitimately


def check_office_archive(data: bytes) -> None:
    """Raise ValidationFailedError if a ZIP-based office file looks like a bomb."""
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as exc:
        raise ValidationFailedError("The file is not a valid Office document") from exc
    with archive:
        members = archive.infolist()
        if len(members) > MAX_ARCHIVE_MEMBERS:
            raise ValidationFailedError("The document contains too many parts")
        total = 0
        for member in members:
            total += member.file_size
            if total > MAX_UNCOMPRESSED_TOTAL:
                raise ValidationFailedError(
                    "The document expands to more than 200 MB and was rejected",
                    code="file_too_complex")
            if (member.file_size > RATIO_CHECK_MIN_SIZE
                    and member.file_size > MAX_MEMBER_RATIO * max(member.compress_size, 1)):
                raise ValidationFailedError(
                    "The document is unusually compressed and was rejected as unsafe",
                    code="file_too_complex")
