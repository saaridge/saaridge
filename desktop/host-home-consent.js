(() => {
  let control = "http://127.0.0.1:3847";
  let agentId = "";

  const $ = (id) => document.getElementById(id);
  const status = (msg, bad) => {
    const el = $("status");
    el.textContent = msg || "";
    el.style.color = bad ? "#d96b6b" : "";
  };

  const params = new URLSearchParams(location.search);
  agentId = params.get("agentId") || "";
  $("agentName").textContent = params.get("agentName") || agentId || "Assistant";
  $("deniedPath").textContent = params.get("path") || "(unknown path)";

  const closeSoon = () => {
    setTimeout(() => window.close(), 400);
  };

  $("denyBtn").onclick = () => {
    status("Denied — home stays read-only.");
    closeSoon();
  };

  $("allowBtn").onclick = async () => {
    if (!agentId) {
      status("Missing agent id", true);
      return;
    }
    $("allowBtn").disabled = true;
    status("Saving grant…");
    try {
      const urls = await window.onebridge?.getUrls?.();
      if (urls?.control) control = urls.control;
      const res = await fetch(`${control}/api/agents/${encodeURIComponent(agentId)}/host-home-write`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grant: true }),
      });
      const body = await res.json();
      if (!res.ok || !body.ok) {
        status(body.error || "Grant failed", true);
        $("allowBtn").disabled = false;
        return;
      }
      status("Granted. Retry saving the file (without sudo).");
      closeSoon();
    } catch (err) {
      status(String(err?.message || err), true);
      $("allowBtn").disabled = false;
    }
  };
})();
