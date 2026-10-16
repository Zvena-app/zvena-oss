import { redirect } from "next/navigation";
import { pageUser } from "@/lib/page";

// The address of the instance itself: there is no marketing page in the
// open-source edition. People who are signed in go to Home, everyone else to
// sign-in, which brings them back here afterwards.
export default async function Root() {
  const { user } = await pageUser();
  redirect(user ? "/home" : "/signin");
}
