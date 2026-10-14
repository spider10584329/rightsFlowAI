"use client";

import { Download, FileSearch, FileText, ScanText, Trash2, Upload, X } from "lucide-react";
import { useRef, useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DataTable, type DataTableColumn, type RowAction } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toaster";
import { downloadFile } from "@/lib/api/client";
import { errorMessage } from "@/lib/api/errors";
import { useClauseScan, useContractDocuments, useDeleteContractDocument, useUploadContractDocument, type ClauseScan, type ContractDocument } from "@/lib/api/hooks/contracts";
import { formatDateTime } from "@/lib/utils";

import { ClauseFlagList } from "./clause-flags";
import { formatBytes } from "./contract-format";

export const ACCEPTED_EXTENSIONS = [".pdf", ".docx", ".txt", ".png", ".jpg", ".jpeg"];
const MAX_BYTES = 25 * 1024 * 1024;

export function checkUpload(file: File): string | null {
  const name = file.name.toLowerCase();
  if (!ACCEPTED_EXTENSIONS.some((ext) => name.endsWith(ext))) return `Unsupported file type. Use ${ACCEPTED_EXTENSIONS.join(", ")}.`;
  if (file.size > MAX_BYTES) return "File exceeds the 25 MB limit.";
  if (file.size === 0) return "The file is empty.";
  return null;
}

export function DocumentsPanel({ orgId, contractId, canEdit, isAdmin }: { orgId: string; contractId: string; canEdit: boolean; isAdmin: boolean }) {
  const documents = useContractDocuments(orgId, contractId);
  const upload = useUploadContractDocument(orgId, contractId);
  const remove = useDeleteContractDocument(orgId, contractId);
  const scan = useClauseScan(orgId, contractId);
  const [file, setFile] = useState<File | null>(null);
  const [label, setLabel] = useState("");
  const [progress, setProgress] = useState<number | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<ContractDocument | null>(null);
  const [scanResult, setScanResult] = useState<{ doc: ContractDocument; result: ClauseScan } | null>(null);
  const [scanError, setScanError] = useState<{ doc: ContractDocument; message: string } | null>(null);
  const [scanningId, setScanningId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const scanRef = useRef<HTMLDivElement>(null);

  const startUpload = () => {
    if (!file) return;
    const problem = checkUpload(file);
    if (problem) {
      setUploadError(problem);
      return;
    }
    setUploadError(null);
    setProgress(0);
    upload.mutate(
      { file, label, onProgress: setProgress },
      {
        onSuccess: (doc) => {
          toast.success("Document uploaded", { description: doc.filename });
          setFile(null);
          setLabel("");
          if (inputRef.current) inputRef.current.value = "";
        },
        onError: (error) => setUploadError(errorMessage(error)),
        onSettled: () => setProgress(null),
      },
    );
  };

  const runScan = (doc: ContractDocument) => {
    setScanningId(doc.id);
    setScanError(null);
    scan.mutate(doc.id, {
      onSuccess: (result) => {
        setScanResult({ doc, result });
        requestAnimationFrame(() => scanRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
      },
      onError: (error) => setScanError({ doc, message: errorMessage(error) }),
      onSettled: () => setScanningId(null),
    });
  };

  const download = async (doc: ContractDocument) => {
    try {
      await downloadFile(`/organizations/${orgId}/contracts/${contractId}/documents/${doc.id}/download`, doc.filename);
    } catch (error) {
      toast.error("Download failed", { description: errorMessage(error) });
    }
  };

  const columns: DataTableColumn<ContractDocument>[] = [
    {
      id: "name",
      header: "Document",
      cell: (doc) => (
        <div className="flex min-w-0 items-start gap-2.5">
          <FileText className="mt-0.5 size-4 shrink-0 text-fg-subtle" aria-hidden />
          <div className="min-w-0">
            <p className="truncate font-medium">{doc.label ?? doc.filename}</p>
            <p className="truncate text-xs text-fg-subtle">
              {doc.filename} · {formatBytes(doc.size_bytes)}
            </p>
          </div>
        </div>
      ),
    },
    {
      id: "text",
      header: "Text",
      hideOnMobile: true,
      cell: (doc) => (doc.text_extractable ? <Badge tone="success">Scannable</Badge> : <Badge tone="neutral">Image — no text</Badge>),
    },
    { id: "uploaded", header: "Uploaded", hideOnMobile: true, cell: (doc) => <span className="text-[13px]">{formatDateTime(doc.created_at)}</span> },
    {
      id: "scan",
      header: <span className="sr-only">Clause scan</span>,
      align: "right",
      cell: (doc) =>
        canEdit && doc.text_extractable ? (
          <Button size="xs" variant="outline" leftIcon={<ScanText aria-hidden />} loading={scanningId === doc.id} onClick={() => runScan(doc)}>
            Clause scan
          </Button>
        ) : null,
    },
  ];

  const actions = (doc: ContractDocument): RowAction[] => [
    { label: "Download", icon: <Download aria-hidden />, onSelect: () => void download(doc) },
    ...(isAdmin ? [{ label: "Delete", icon: <Trash2 aria-hidden />, destructive: true, separated: true, onSelect: () => setDeleting(doc) }] : []),
  ];

  return (
    <div className="space-y-5">
      {canEdit ? (
        <Card>
          <CardHeader title="Upload document" description="PDF, DOCX, TXT, PNG or JPG up to 25 MB. Files are stored privately and served only to members." />
          <CardBody className="grid gap-3 md:grid-cols-[1fr_1fr_auto] md:items-start">
            <FormField label="File" error={uploadError ?? undefined}>
              <Input
                ref={inputRef}
                type="file"
                accept={ACCEPTED_EXTENSIONS.join(",")}
                className="h-auto py-1.5 file:mr-3 file:rounded file:border-0 file:bg-surface-2 file:px-2 file:py-1 file:text-[13px]"
                onChange={(event) => {
                  setFile(event.target.files?.[0] ?? null);
                  setUploadError(null);
                }}
                disabled={upload.isPending}
              />
            </FormField>
            <FormField label="Label" hint="Optional, e.g. “Signed agreement”.">
              <Input value={label} maxLength={255} onChange={(event) => setLabel(event.target.value)} disabled={upload.isPending} />
            </FormField>
            <Button className="md:mt-6" leftIcon={<Upload aria-hidden />} onClick={startUpload} disabled={!file} loading={upload.isPending}>
              Upload
            </Button>
            {progress !== null ? (
              <div className="md:col-span-3" role="progressbar" aria-label="Upload progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
                <div className="flex justify-between text-xs text-fg-muted">
                  <span>{progress >= 1 ? "Processing…" : "Uploading…"}</span>
                  <span className="tabular-nums">{Math.round(progress * 100)}%</span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-3">
                  <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${Math.round(progress * 100)}%` }} />
                </div>
              </div>
            ) : null}
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader title="Documents" />
        <div className="overflow-x-auto">
          <DataTable
            columns={columns}
            data={documents.data}
            getRowId={(doc) => doc.id}
            getRowLabel={(doc) => doc.label ?? doc.filename}
            isLoading={documents.isLoading}
            error={documents.error}
            onRetry={() => void documents.refetch()}
            rowActions={actions}
            caption="Contract documents"
            emptyState={<EmptyState compact icon={<FileSearch aria-hidden />} title="No documents" description={canEdit ? "Upload the signed agreement to scan its clauses." : "No documents have been uploaded."} />}
          />
        </div>
      </Card>

      {scanError ? (
        <Alert tone="danger" title={`Clause scan failed for ${scanError.doc.label ?? scanError.doc.filename}`}>
          {scanError.message}
        </Alert>
      ) : null}

      {scanResult ? (
        <Card ref={scanRef}>
          <CardHeader
            title={`Clause scan · ${scanResult.doc.label ?? scanResult.doc.filename}`}
            description={`${scanResult.result.flags.length} excerpts in ${scanResult.result.categories.length} categories · ${scanResult.result.characters_scanned.toLocaleString()} characters scanned`}
            actions={<Button size="xs" variant="ghost" leftIcon={<X aria-hidden />} onClick={() => setScanResult(null)}>Close</Button>}
          />
          <CardBody className="space-y-4">
            <Alert tone="info">{scanResult.result.notice}</Alert>
            {scanResult.result.categories.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {scanResult.result.categories.map((category) => (
                  <Badge key={category} tone="neutral">
                    {category.replace(/_/g, " ")}
                  </Badge>
                ))}
              </div>
            ) : null}
            <ClauseFlagList flags={scanResult.result.flags} emptyText="No clause keywords matched in this document." />
          </CardBody>
        </Card>
      ) : null}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Delete document?"
        description={deleting ? `${deleting.label ?? deleting.filename} will be removed from this contract.` : undefined}
        confirmLabel="Delete document"
        onConfirm={async () => {
          if (!deleting) return;
          await remove.mutateAsync(deleting.id);
          toast.success("Document deleted");
        }}
      />
    </div>
  );
}
