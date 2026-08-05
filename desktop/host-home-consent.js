(() => {
  let control = "http://127.0.0.1:3847";
  let agentId = "";

  const $ = (id) => document.getElementById(id);
  const status = (msg, bad, elId = "status") => {
    const el = $(elId);
    if (!el) return;
    el.textContent = msg || "";
    el.style.color = bad ? "#d96b6b" : "";
  };

  const params = new URLSearchParams(location.search);
  agentId = params.get("agentId") || "";
  $("agentName").textContent = params.get("agentName") || agentId || "Assistant";
  $("deniedPath").textContent = params.get("path") || "(unknown path)";

  const closeSoon = () => {
    setTimeout(() => window.close(), 450);
  };

  const postGrant = async (body) => {
    const urls = await window.saaridge?.getUrls?.();
    if (urls?.control) control = urls.control;
    const res = await fetch(
      `${control}/api/agents/${encodeURIComponent(agentId)}/host-home-write`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(data.error || "Request failed");
    }
    return data;
  };

  const allow = async (statusId) => {
    if (!agentId) {
      status("Missing agent id", true, statusId);
      return;
    }
    $("allowBtn").disabled = true;
    $("retryBtn").disabled = true;
    $("skipBtn").disabled = true;
    status("Saving grant…", false, statusId);
    try {
      await postGrant({ grant: true });
      status("Granted. Retry saving the file (without sudo).", false, statusId);
      closeSoon();
    } catch (err) {
      status(String(err?.message || err), true, statusId);
      $("allowBtn").disabled = false;
      $("retryBtn").disabled = false;
      $("skipBtn").disabled = false;
    }
  };

  $("denyBtn").onclick = () => {
    $("stepAsk").style.display = "none";
    $("stepDenied").style.display = "grid";
  };

  $("allowBtn").onclick = () => allow("status");
  $("retryBtn").onclick = () => allow("status2");

  $("skipBtn").onclick = async () => {
    if (!agentId) {
      status("Missing agent id", true, "status2");
      return;
    }
    $("skipBtn").disabled = true;
    $("retryBtn").disabled = true;
    status("Saving choice…", false, "status2");
    try {
      await postGrant({ grant: false, skipped: true });
      status(
        "Skipped — home stays read-only for this agent.",
        false,
        "status2",
      );
      closeSoon();
    } catch (err) {
      status(String(err?.message || err), true, "status2");
      $("skipBtn").disabled = false;
      $("retryBtn").disabled = false;
    }
  };
})();
