import type { Metadata } from "next";
import { pageMetadata } from "@/lib/meta";
import { OperatorLegal } from "@/components/zvena/OperatorLegal";
import "../legal.css";

export const metadata: Metadata = pageMetadata({ title: "Privacy Policy", description: "The Privacy Policy of this zvena server.", path: "/legal/privacy" });

export default async function Page() {
  return <OperatorLegal kind="privacy" />;
}
