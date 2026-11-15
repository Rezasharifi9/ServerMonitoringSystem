import { z } from "zod";

const document = (array: boolean) => z.string().max(300000).nullable().superRefine((text, ctx) => {
  if (text === null) return;
  if (new TextEncoder().encode(text).length > 300000) {
    ctx.addIssue({ code: "custom", message: "حداکثر اندازهٔ فایل ۳۰۰ کیلوبایت است." });
    return;
  }
  try {
    const value = JSON.parse(text.replace(/^\uFEFF/, ""));
    if (array ? !Array.isArray(value) || value.some((item: unknown) => !item || typeof item !== "object" || Array.isArray(item))
      : !value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.rules)) throw new Error();
  } catch { ctx.addIssue({ code: "custom", message: array ? "Outbound باید آرایهٔ JSON باشد." : "Route باید یک شیء JSON دارای rules باشد." }); }
});
export const v2bxFilesSchema = z.object({ route: document(false), outbound: document(true) }).strict();
export type V2bxFiles = z.infer<typeof v2bxFilesSchema>;
