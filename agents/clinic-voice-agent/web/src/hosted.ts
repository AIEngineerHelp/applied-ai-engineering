import { useEffect, useState } from "react";
import { getConfig } from "./api";

/** True on the deployed demo: recorded data plus live calls, no local server behind it. */
export function useHosted(): boolean {
  const [hosted, setHosted] = useState(false);
  useEffect(() => {
    getConfig().then((c) => setHosted(Boolean(c.hosted)), () => undefined);
  }, []);
  return hosted;
}
