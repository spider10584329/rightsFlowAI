from pathlib import Path

from sqlalchemy import select

from app.models.contract import ContractDocument
from app.models.platform import AuditLog, StoredFile
from app.services import storage

PDF_BYTES = b"%PDF-1.4\n% minimal test document\n%%EOF\n"


def curl(org_id: str, path: str = "") -> str:
    return f"/api/v1/organizations/{org_id}/contracts{path}"


def furl(org_id: str, path: str = "") -> str:
    return f"/api/v1/organizations/{org_id}/files{path}"


def make_contract(client, team) -> str:
    response = client.post(curl(team["org_id"]), json={"title": "Deal", "contract_type": "licensing"},
                           headers=team["manager"]["headers"])
    assert response.status_code == 201, response.text
    return response.json()["id"]


def upload(client, team, contract_id, filename, data, role="manager", org_id=None):
    return client.post(
        curl(org_id or team["org_id"], f"/{contract_id}/documents"),
        files={"file": (filename, data, "application/octet-stream")},
        headers=team[role]["headers"],
    )


def test_upload_validation(client, team, db):
    cid = make_contract(client, team)
    cases = [
        ("malware.exe", b"MZ\x90\x00", "unsupported_file_type"),
        ("noextension", b"hello", "unsupported_file_type"),
        ("statement.csv", b"a,b\n1,2\n", "unsupported_file_type"),   # not allowed for contracts
        ("fake.pdf", b"<html><script>alert(1)</script></html>", "file_signature_mismatch"),
        ("fake.docx", b"%PDF-1.4 not a zip", "file_signature_mismatch"),
        ("photo.png", b"\xff\xd8\xff\xe0 jpeg bytes", "file_signature_mismatch"),
        ("empty.pdf", b"", "validation_failed"),
        ("binary.txt", b"abc\x00def", "validation_failed"),
    ]
    for filename, data, code in cases:
        response = upload(client, team, cid, filename, data)
        assert response.status_code == 422, (filename, response.text)
        assert response.json()["error"]["code"] == code, filename
    assert db.scalar(select(StoredFile.id)) is None

    # Viewers cannot upload; outsiders get 404.
    assert upload(client, team, cid, "ok.pdf", PDF_BYTES, role="viewer").status_code == 403
    assert upload(client, team, cid, "ok.pdf", PDF_BYTES, role="outsider").status_code == 404
    # Unknown contract -> 404.
    assert upload(client, team, "00000000-0000-0000-0000-000000000000", "ok.pdf", PDF_BYTES).status_code == 404


def test_upload_size_limit(client, team, monkeypatch):
    from app.core.config import settings

    cid = make_contract(client, team)
    monkeypatch.setattr(settings, "storage_max_upload_mb", 1)
    response = upload(client, team, cid, "big.pdf", PDF_BYTES + b"0" * (1024 * 1024 + 10))
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "file_too_large"


def test_path_traversal_filename_is_stored_safely(client, team, db, tmp_path):
    cid = make_contract(client, team)
    response = upload(client, team, cid, "../../evil.pdf", PDF_BYTES)
    assert response.status_code == 201, response.text
    doc = response.json()
    assert doc["filename"] == "evil.pdf"
    assert doc["label"] is None or ".." not in doc["label"]
    record = db.get(StoredFile, doc["file_id"])
    assert ".." not in record.storage_key and "evil" not in record.storage_key
    assert record.storage_key.startswith(f"{team['org_id']}/contract/")
    root = storage.get_storage().root
    stored_path = (root / record.storage_key).resolve()
    assert stored_path.is_file() and stored_path.is_relative_to(root)
    assert stored_path.read_bytes() == PDF_BYTES
    assert not (Path(root).parent.parent / "evil.pdf").exists()
    # Windows-style traversal is neutralized too.
    response = upload(client, team, cid, "..\\..\\windows\\evil2.pdf", PDF_BYTES)
    assert response.status_code == 201 and response.json()["filename"] == "evil2.pdf"


def test_download_authorization_and_headers(client, team, db):
    cid = make_contract(client, team)
    doc = upload(client, team, cid, 'quote"name\r\nX-Injected: 1.pdf', PDF_BYTES).json()
    org_id = team["org_id"]
    dl = curl(org_id, f"/{cid}/documents/{doc['id']}/download")

    response = client.get(dl, headers=team["viewer"]["headers"])
    assert response.status_code == 200
    assert response.content == PDF_BYTES
    assert response.headers["content-type"].startswith("application/pdf")
    assert response.headers["x-content-type-options"] == "nosniff"
    disposition = response.headers["content-disposition"]
    assert disposition.startswith("attachment;")
    assert "\r" not in disposition and "\n" not in disposition and "x-injected" not in response.headers
    assert 'quote"' not in disposition
    assert "no-store" in response.headers["cache-control"]
    assert db.scalar(select(AuditLog).where(AuditLog.action == "file.downloaded", AuditLog.entity_id == cid))

    # Outsiders get 404 through every path, including their own org id.
    outsider = team["outsider"]["headers"]
    assert client.get(dl, headers=outsider).status_code == 404
    assert client.get(furl(org_id, f"/{doc['file_id']}/download"), headers=outsider).status_code == 404
    other_org = team["other_org"]["id"]
    assert client.get(furl(other_org, f"/{doc['file_id']}/download"), headers=outsider).status_code == 404
    assert client.get(furl(other_org, f"/{doc['file_id']}"), headers=outsider).status_code == 404
    assert client.get(curl(other_org, f"/{cid}/documents/{doc['id']}/download"), headers=outsider).status_code == 404
    # Unauthenticated -> 401.
    assert client.get(dl).status_code == 401

    # A document id under the wrong contract is 404.
    other_cid = make_contract(client, team)
    assert client.get(curl(org_id, f"/{other_cid}/documents/{doc['id']}/download"),
                      headers=team["viewer"]["headers"]).status_code == 404


def test_generic_files_router(client, team):
    cid = make_contract(client, team)
    doc = upload(client, team, cid, "Contract Ü.pdf", PDF_BYTES).json()
    org_id = team["org_id"]
    meta = client.get(furl(org_id, f"/{doc['file_id']}"), headers=team["viewer"]["headers"])
    assert meta.status_code == 200
    body = meta.json()
    assert body["original_filename"] == "Contract Ü.pdf" and body["category"] == "contract"
    assert body["size_bytes"] == len(PDF_BYTES)
    assert "storage_key" not in body and "storage_backend" not in body
    response = client.get(furl(org_id, f"/{doc['file_id']}/download"), headers=team["viewer"]["headers"])
    assert response.status_code == 200 and response.content == PDF_BYTES
    disposition = response.headers["content-disposition"]
    assert "filename*=UTF-8''Contract%20%C3%9C.pdf" in disposition
    assert response.headers["x-content-type-options"] == "nosniff"
    assert client.get(furl(org_id, "/does-not-exist"), headers=team["viewer"]["headers"]).status_code == 404


def test_document_list_and_delete(client, team, db):
    cid = make_contract(client, team)
    org_id = team["org_id"]
    doc = upload(client, team, cid, "signed.pdf", PDF_BYTES).json()
    listed = client.get(curl(org_id, f"/{cid}/documents"), headers=team["viewer"]["headers"]).json()
    assert [d["id"] for d in listed] == [doc["id"]]
    detail = client.get(curl(org_id, f"/{cid}"), headers=team["viewer"]["headers"]).json()
    assert [d["id"] for d in detail["documents"]] == [doc["id"]]

    path = curl(org_id, f"/{cid}/documents/{doc['id']}")
    assert client.delete(path, headers=team["viewer"]["headers"]).status_code == 403
    assert client.delete(path, headers=team["manager"]["headers"]).status_code == 403
    assert client.delete(path, headers=team["outsider"]["headers"]).status_code == 404
    assert client.delete(path, headers=team["admin"]["headers"]).status_code == 200

    db.rollback()
    db.expire_all()
    assert db.get(StoredFile, doc["file_id"]).is_deleted is True
    assert db.get(ContractDocument, doc["id"]) is None
    assert client.get(f"{path}/download", headers=team["admin"]["headers"]).status_code == 404
    assert client.get(furl(org_id, f"/{doc['file_id']}/download"), headers=team["admin"]["headers"]).status_code == 404
    assert client.get(curl(org_id, f"/{cid}/documents"), headers=team["viewer"]["headers"]).json() == []
    assert client.delete(path, headers=team["admin"]["headers"]).status_code == 404


def test_deleting_contract_soft_deletes_its_files(client, team, db):
    cid = make_contract(client, team)
    doc = upload(client, team, cid, "signed.pdf", PDF_BYTES).json()
    assert client.delete(curl(team["org_id"], f"/{cid}"), headers=team["admin"]["headers"]).status_code == 200
    db.rollback()
    db.expire_all()
    assert db.get(StoredFile, doc["file_id"]).is_deleted is True
    assert client.get(furl(team["org_id"], f"/{doc['file_id']}"), headers=team["admin"]["headers"]).status_code == 404
