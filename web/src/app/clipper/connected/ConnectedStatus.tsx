"use client";

import { useEffect, useState } from "react";
import { CircleCheck, CircleX, TriangleAlert } from "lucide-react";

type Labels = { title: string; lead: string; deniedTitle: string; deniedLead: string; missing: string };
type State = "wait" | "connected" | "denied" | "missing";

/**
 * How the connection went. The extension's content script takes the code
 * from the address at document start and, once it has traded it, marks
 * <html data-zv-clipper="connected"> (or an error name). A code still in the
 * address means no extension took it.
 */
export function ConnectedStatus({ labels }: { labels: Labels }) {
  const [state, setState] = useState<State>("wait");
  useEffect(() => {
    if (location.hash === "#denied") {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setState("denied");
      return;
    }
    const started = Date.now();
    const timer = setInterval(() => {
      const mark = document.documentElement.dataset.zvClipper;
      const waited = Date.now() - started;
      let next: State | null = null;
      if (mark) next = mark === "connected" ? "connected" : "missing";
      else if (/code=/.test(location.hash) && waited > 1500) {
        // The code goes from the address all the same (useless without the extension's verifier).
        history.replaceState(null, "", location.pathname);
        next = "missing";
      } else if (waited > 6000) next = "connected";
      if (next) {
        clearInterval(timer);
        setState(next);
      }
    }, 150);
    return () => clearInterval(timer);
  }, []);
  if (state === "wait") return <p className="zv-lead">…</p>;
  const [icon, title, lead] =
    state === "connected" ? [<CircleCheck key="i" />, labels.title, labels.lead] : state === "denied" ? [<CircleX key="i" />, labels.deniedTitle, labels.deniedLead] : [<TriangleAlert key="i" />, "", labels.missing];
  return (
    <>
      <div className="zv-panel-icon" data-state={state}>
        {icon}
      </div>
      {title && (
        <h1 data-test="clipper-status" data-state={state}>
          {title}
        </h1>
      )}
      <p className="zv-lead" role={state === "missing" ? "alert" : undefined} data-test={title ? undefined : "clipper-status"} data-state={title ? undefined : state}>
        {lead}
      </p>
    </>
  );
}
