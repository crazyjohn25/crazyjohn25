"use client";

import { useEffect } from "react";

export default function Boot() {
  useEffect(() => {
    if (document.querySelector("script[data-desk]")) return;
    const script = document.createElement("script");
    script.src = "/static/app.js";
    script.dataset.desk = "1";
    document.body.appendChild(script);
  }, []);
  return null;
}
