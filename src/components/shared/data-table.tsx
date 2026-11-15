"use client";

import { flexRender, type RowData, type SortingState } from "@tanstack/react-table";
import { getCoreRowModel, getPaginationRowModel, getSortedRowModel, useLegacyTable, type LegacyColumnDef } from "@tanstack/react-table/legacy";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/kit";
import { useI18n } from "@/i18n/provider";

export function DataTable<T extends RowData>({ columns, data, pageSize = 8, keepPage = false }: {
  columns: LegacyColumnDef<T>[]; data: T[]; pageSize?: number; keepPage?: boolean;
}) {
  const { t } = useI18n();
  const [sorting, setSorting] = useState<SortingState>([]);
  const table = useLegacyTable({
    data,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    autoResetPageIndex: !keepPage,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageIndex: 0, pageSize } },
  });

  const pageIndex = table.getState().pagination.pageIndex;
  const lastPage = Math.max(0, table.getPageCount() - 1);
  useEffect(() => {
    if (keepPage && pageIndex > lastPage) table.setPageIndex(lastPage);
  }, [keepPage, pageIndex, lastPage, table]);

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="bg-muted/70 text-muted-foreground">
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                {group.headers.map((header) => (
                  <th key={header.id} className="px-3 py-3 text-start font-medium">
                    {header.isPlaceholder ? null : (
                      <button className="inline-flex items-center gap-1" onClick={header.column.getToggleSortingHandler()}>
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        {{ asc: "↑", desc: "↓" }[header.column.getIsSorted() as string] ?? null}
                      </button>
                    )}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.length === 0 ? (
              <tr>
                <td className="px-3 py-10 text-center text-muted-foreground" colSpan={columns.length}>{t("common.noResults")}</td>
              </tr>
            ) : (
              table.getRowModel().rows.map((row) => (
                <tr key={row.id} className="border-t border-border transition-colors hover:bg-muted/40">
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className="px-3 py-3 align-middle">{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>
          {t("common.page", { page: table.getState().pagination.pageIndex + 1, pages: Math.max(table.getPageCount(), 1) })}
        </span>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={!table.getCanPreviousPage()} onClick={() => table.previousPage()}>{t("common.previous")}</Button>
          <Button variant="outline" size="sm" disabled={!table.getCanNextPage()} onClick={() => table.nextPage()}>{t("common.next")}</Button>
        </div>
      </div>
    </div>
  );
}
