"use client";

export function OfflineRetry({ label }: { label: string }) {
  return (
    <button type="button" className="zv-btn zv-btn-lg zv-btn-block" onClick={() => location.reload()}>
      {label}
    </button>
  );
}
