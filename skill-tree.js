(() => {
  const root = document.querySelector("#skill-tree-page");
  if (!root) return;

  const originalTitle = document.title;
  const encryptedPayloadUrl = "./skill-tree.enc";
  const progressStorageKey = "zbc-private-progress-v1";
  let encryptedPackagePromise = null;
  let payload = null;
  let completed = readProgress();
  let activeSubjectId = null;
  let activeNodeId = null;
  let connectorFrame = null;

  function isSecretRoute() {
    return window.location.hash.toLowerCase() === "#st";
  }

  function readProgress() {
    try {
      const saved = JSON.parse(window.localStorage.getItem(progressStorageKey));
      return new Set(Array.isArray(saved) ? saved : []);
    } catch {
      return new Set();
    }
  }

  function saveProgress() {
    try {
      window.localStorage.setItem(progressStorageKey, JSON.stringify([...completed]));
    } catch {
      // Progress remains available for the current page when storage is unavailable.
    }
  }

  function bytesFromBase64(value) {
    const decoded = window.atob(value);
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  }

  async function getEncryptedPackage() {
    if (!encryptedPackagePromise) {
      encryptedPackagePromise = fetch(encryptedPayloadUrl, { cache: "no-store" })
        .then((response) => {
          if (!response.ok) throw new Error("Encrypted payload unavailable");
          return response.json();
        })
        .catch((error) => {
          encryptedPackagePromise = null;
          throw error;
        });
    }
    return encryptedPackagePromise;
  }

  async function decryptPayload(passphrase) {
    if (!window.crypto?.subtle) {
      throw new Error("Secure browser context required");
    }

    const encryptedPackage = await getEncryptedPackage();
    const encoder = new TextEncoder();
    const keyMaterial = await window.crypto.subtle.importKey(
      "raw",
      encoder.encode(passphrase),
      "PBKDF2",
      false,
      ["deriveKey"]
    );
    const key = await window.crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: bytesFromBase64(encryptedPackage.salt),
        iterations: encryptedPackage.iterations,
        hash: "SHA-256",
      },
      keyMaterial,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"]
    );
    const decrypted = await window.crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: bytesFromBase64(encryptedPackage.iv),
      },
      key,
      bytesFromBase64(encryptedPackage.data)
    );

    return JSON.parse(new TextDecoder().decode(decrypted));
  }

  function showGate() {
    document.title = `Private | ${originalTitle}`;
    root.innerHTML = `
      <section class="st-gate" aria-labelledby="st-gate-title">
        <div class="st-gate-card">
          <p class="st-kicker">Private archive</p>
          <div class="st-gate-mark" aria-hidden="true">Z</div>
          <h1 id="st-gate-title">Key required.</h1>
          <p class="st-gate-copy">This page is encrypted. Enter your 8 letter hash key to continue.</p>
          <form class="st-key-form" novalidate>
            <label class="visually-hidden" for="st-key">Access key</label>
            <input
              class="st-key-input"
              id="st-key"
              name="key"
              type="password"
              inputmode="text"
              autocomplete="off"
              autocapitalize="none"
              spellcheck="false"
              placeholder="Access key"
              required
            >
            <button class="st-key-submit" type="submit">Decrypt</button>
            <p class="st-key-error" role="alert"></p>
          </form>
        </div>
      </section>
    `;

    const form = root.querySelector(".st-key-form");
    const card = root.querySelector(".st-gate-card");
    const input = root.querySelector(".st-key-input");
    const button = root.querySelector(".st-key-submit");
    const error = root.querySelector(".st-key-error");

    window.requestAnimationFrame(() => input?.focus());

    form?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const passphrase = input.value;
      if (!passphrase || button.disabled) return;

      button.disabled = true;
      button.textContent = "Decrypting…";
      error.textContent = "";
      card.classList.remove("is-denied");

      try {
        payload = await decryptPayload(passphrase);
        input.value = "";
        renderApp();
      } catch (decryptionError) {
        const unavailable = decryptionError.message === "Secure browser context required" ||
          decryptionError.message === "Encrypted payload unavailable";
        error.textContent = unavailable
          ? "The encrypted archive is unavailable in this browser."
          : "That key did not unlock the archive.";
        card.classList.add("is-denied");
        input.select();
      } finally {
        button.disabled = false;
        button.textContent = "Decrypt";
      }
    });
  }

  function nodeKey(subject, node) {
    return `${subject.id}:${node.id}`;
  }

  function isComplete(subject, node) {
    return completed.has(nodeKey(subject, node));
  }

  function isUnlocked(subject, node) {
    return node.parents.length === 0 || node.parents.every((parentId) => {
      const parent = subject.nodes.find((candidate) => candidate.id === parentId);
      return parent && isComplete(subject, parent);
    });
  }

  function getActiveSubject() {
    return payload.subjects.find((subject) => subject.id === activeSubjectId) || payload.subjects[0];
  }

  function getActiveNode(subject) {
    return subject.nodes.find((node) => node.id === activeNodeId) || subject.nodes[0];
  }

  function countCompleted(subject) {
    return subject.nodes.filter((node) => isComplete(subject, node)).length;
  }

  function countAllCompleted() {
    return payload.subjects.reduce((total, subject) => total + countCompleted(subject), 0);
  }

  function renderApp() {
    activeSubjectId = activeSubjectId || payload.subjects[0].id;
    activeNodeId = null;
    document.title = `${payload.title} | Zebra Book Club`;

    root.innerHTML = `
      <div class="st-app">
        <header class="st-app-header">
          <div class="st-app-utility">
            <p class="st-wordmark">${payload.wordmark}</p>
            <p class="st-total-progress"></p>
          </div>
          <h1></h1>
          <p class="st-app-intro">${payload.intro}</p>
        </header>
        <nav class="st-subject-tabs" aria-label="Skill disciplines" role="tablist"></nav>
        <div class="st-workspace">
          <section class="st-tree-panel" aria-live="polite">
            <div class="st-tree-heading">
              <div>
                <p class="st-tree-index"></p>
                <h2></h2>
              </div>
              <p class="st-subject-progress"></p>
            </div>
            <div class="st-progress-track" aria-hidden="true">
              <span class="st-progress-value"></span>
            </div>
            <div class="st-tree-scroll" tabindex="0" aria-label="Scrollable skill tree">
              <div class="st-tree-map">
                <svg class="st-connectors" aria-hidden="true"></svg>
                <div class="st-tree-grid" role="tabpanel"></div>
              </div>
            </div>
          </section>
          <aside class="st-detail-panel" aria-live="polite"></aside>
        </div>
      </div>
    `;

    const title = root.querySelector(".st-app-header h1");
    const titleWords = payload.title.split(" ");
    title.append(document.createTextNode(`${titleWords.slice(0, -1).join(" ")} `));
    const outlinedWord = document.createElement("span");
    outlinedWord.textContent = titleWords.at(-1);
    title.append(outlinedWord);

    renderTabs();
    renderSubject();
    updateTotalProgress();
    window.requestAnimationFrame(() => {
      root.querySelector(`#st-tab-${activeSubjectId}`)?.scrollIntoView({
        block: "nearest",
        inline: "center",
      });
    });
  }

  function renderTabs() {
    const tabs = root.querySelector(".st-subject-tabs");
    tabs.replaceChildren();

    payload.subjects.forEach((subject, index) => {
      const tab = document.createElement("button");
      tab.className = "st-subject-tab";
      tab.type = "button";
      tab.role = "tab";
      tab.id = `st-tab-${subject.id}`;
      tab.setAttribute("aria-controls", "st-tree-grid");
      tab.setAttribute("aria-selected", String(subject.id === activeSubjectId));
      tab.textContent = `${String(index + 1).padStart(2, "0")} ${subject.name}`;
      tab.addEventListener("click", () => {
        activeSubjectId = subject.id;
        activeNodeId = null;
        renderTabs();
        renderSubject();
        root.querySelector(`#${tab.id}`)?.scrollIntoView({ block: "nearest", inline: "center" });
      });
      tabs.append(tab);
    });
  }

  function renderSubject() {
    const subject = getActiveSubject();
    const subjectIndex = payload.subjects.indexOf(subject);
    const completedCount = countCompleted(subject);
    const percentage = (completedCount / subject.nodes.length) * 100;
    const heading = root.querySelector(".st-tree-heading h2");
    const index = root.querySelector(".st-tree-index");
    const progress = root.querySelector(".st-subject-progress");
    const progressValue = root.querySelector(".st-progress-value");
    const grid = root.querySelector(".st-tree-grid");
    const scroller = root.querySelector(".st-tree-scroll");
    const subjectChanged = scroller.dataset.subjectId !== subject.id;
    const previousScroll = { left: scroller.scrollLeft, top: scroller.scrollTop };

    heading.textContent = subject.name;
    index.textContent = `Discipline ${String(subjectIndex + 1).padStart(2, "0")}`;
    progress.textContent = `${completedCount} / ${subject.nodes.length} complete`;
    progressValue.style.setProperty("--progress", `${percentage}%`);
    grid.id = "st-tree-grid";
    grid.setAttribute("aria-labelledby", `st-tab-${subject.id}`);
    grid.replaceChildren();

    subject.nodes.forEach((node, nodeIndex) => {
      const complete = isComplete(subject, node);
      const unlocked = isUnlocked(subject, node);
      const button = document.createElement("button");
      button.className = "st-node";
      button.type = "button";
      button.dataset.nodeId = node.id;
      button.style.gridColumn = node.lane;
      button.style.gridRow = node.tier + 1;
      button.classList.toggle("is-complete", complete);
      button.classList.toggle("is-locked", !unlocked && !complete);
      button.classList.toggle("is-selected", node.id === activeNodeId);
      button.setAttribute("aria-pressed", String(complete));
      button.innerHTML = `
        <span class="st-node-state">
          ${complete ? payload.labels.complete : unlocked ? payload.labels.available : payload.labels.locked}
          <span class="st-node-number">${String(nodeIndex + 1).padStart(2, "0")}</span>
        </span>
        <span class="st-node-title">${node.title}</span>
      `;
      button.addEventListener("click", () => {
        activeNodeId = node.id;
        grid.querySelectorAll(".st-node").forEach((item) => {
          item.classList.toggle("is-selected", item.dataset.nodeId === node.id);
        });
        renderDetails();
      });
      grid.append(button);
    });

    if (!activeNodeId || !subject.nodes.some((node) => node.id === activeNodeId)) {
      const nextNode = subject.nodes.find((node) => isUnlocked(subject, node) && !isComplete(subject, node));
      activeNodeId = (nextNode || subject.nodes.at(-1)).id;
      grid.querySelector(`[data-node-id="${activeNodeId}"]`)?.classList.add("is-selected");
    }

    scroller.dataset.subjectId = subject.id;
    if (subjectChanged) {
      window.requestAnimationFrame(() => {
        scroller.scrollLeft = Math.max(0, (scroller.scrollWidth - scroller.clientWidth) / 2);
        scroller.scrollTop = 0;
      });
    } else {
      scroller.scrollTo(previousScroll);
    }
    renderDetails();
    scheduleConnectors();
  }

  function renderDetails() {
    const subject = getActiveSubject();
    const node = getActiveNode(subject);
    const nodeIndex = subject.nodes.indexOf(node);
    const complete = isComplete(subject, node);
    const unlocked = isUnlocked(subject, node);
    const panel = root.querySelector(".st-detail-panel");
    const unmetParents = node.parents
      .map((id) => subject.nodes.find((candidate) => candidate.id === id))
      .filter((parent) => parent && !isComplete(subject, parent));

    panel.innerHTML = `
      <div class="st-detail-topline">
        <p class="st-detail-label">${complete ? payload.labels.complete : unlocked ? payload.labels.available : payload.labels.locked}</p>
        <p class="st-detail-count">${String(nodeIndex + 1).padStart(2, "0")} / ${String(subject.nodes.length).padStart(2, "0")}</p>
      </div>
      <h3>${node.title}</h3>
      <p class="st-detail-description">${node.description}</p>
      <hr class="st-detail-rule">
      <p class="st-detail-label">${payload.labels.practice}</p>
      <p class="st-detail-practice">${node.practice}</p>
      <button class="st-action${complete ? " is-remove" : ""}" type="button" ${!unlocked && !complete ? "disabled" : ""}>
        ${complete ? payload.labels.remove : payload.labels.mark}
      </button>
      ${unmetParents.length ? `<p class="st-lock-note">${payload.labels.requires}: ${unmetParents.map((parent) => parent.title).join(" + ")}</p>` : ""}
    `;

    panel.querySelector(".st-action")?.addEventListener("click", () => {
      if (!unlocked && !complete) return;
      if (complete) {
        removeNodeAndDescendants(subject, node);
      } else {
        completed.add(nodeKey(subject, node));
      }
      saveProgress();
      renderSubject();
      updateTotalProgress();
    });
  }

  function removeNodeAndDescendants(subject, node) {
    const removedIds = new Set([node.id]);
    let foundDescendant = true;

    while (foundDescendant) {
      foundDescendant = false;
      subject.nodes.forEach((candidate) => {
        if (!removedIds.has(candidate.id) && candidate.parents.some((id) => removedIds.has(id))) {
          removedIds.add(candidate.id);
          foundDescendant = true;
        }
      });
    }

    removedIds.forEach((id) => completed.delete(`${subject.id}:${id}`));
  }

  function updateTotalProgress() {
    const total = payload.subjects.reduce((sum, subject) => sum + subject.nodes.length, 0);
    const totalProgress = root.querySelector(".st-total-progress");
    totalProgress.textContent = `${countAllCompleted()} / ${total} ${payload.labels.total}`;
  }

  function scheduleConnectors() {
    if (connectorFrame) window.cancelAnimationFrame(connectorFrame);
    connectorFrame = window.requestAnimationFrame(drawConnectors);
  }

  function drawConnectors() {
    const subject = getActiveSubject();
    const map = root.querySelector(".st-tree-map");
    const svg = root.querySelector(".st-connectors");
    if (!map || !svg) return;

    const mapRect = map.getBoundingClientRect();
    svg.setAttribute("viewBox", `0 0 ${mapRect.width} ${mapRect.height}`);
    svg.replaceChildren();

    subject.nodes.forEach((node) => {
      const childElement = map.querySelector(`[data-node-id="${node.id}"]`);
      if (!childElement) return;
      const childRect = childElement.getBoundingClientRect();

      node.parents.forEach((parentId) => {
        const parent = subject.nodes.find((candidate) => candidate.id === parentId);
        const parentElement = map.querySelector(`[data-node-id="${parentId}"]`);
        if (!parent || !parentElement) return;
        const parentRect = parentElement.getBoundingClientRect();
        const startX = parentRect.left - mapRect.left + parentRect.width / 2;
        const startY = parentRect.bottom - mapRect.top;
        const endX = childRect.left - mapRect.left + childRect.width / 2;
        const endY = childRect.top - mapRect.top;
        const middleY = startY + (endY - startY) / 2;
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", `M ${startX} ${startY} C ${startX} ${middleY}, ${endX} ${middleY}, ${endX} ${endY}`);
        path.setAttribute("class", `st-connector${isComplete(subject, parent) ? " is-active" : ""}`);
        svg.append(path);
      });
    });
  }

  function syncRoute() {
    document.documentElement.classList.toggle("st-mode", isSecretRoute());

    if (!isSecretRoute()) {
      document.title = originalTitle;
      root.replaceChildren();
      return;
    }

    if (payload) {
      renderApp();
    } else {
      showGate();
    }
  }

  window.addEventListener("resize", scheduleConnectors);
  window.addEventListener("hashchange", syncRoute);
  syncRoute();
})();
