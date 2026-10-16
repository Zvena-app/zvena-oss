import type { Metadata } from "next";
import { pageMetadata } from "@/lib/meta";
import { OperatorLegal } from "@/components/zvena/OperatorLegal";
import "../legal.css";

export const metadata: Metadata = pageMetadata({ title: "Terms of Service", description: "The Terms of Service of this zvena server.", path: "/legal/terms" });

export default async function Page() {
  return <OperatorLegal kind="terms" />;
}
