(() => {
  const root = document.querySelector("#skill-tree-page");
  if (!root) return;

  const originalTitle = document.title;
  const encryptedPayloadUrl = "./content.enc";
  let encryptedPackagePromise = null;
  let payload = null;
  let activeSubjectId = null;
  let activeNodeId = null;
  let activeTreeGroup = null;
  let connectorFrame = null;

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
    document.title = originalTitle;
    root.innerHTML = `
      <div class="st-gate-shell">
        <header class="st-gate-header">
          <p>Zebra Book Club</p>
          <p>Private</p>
        </header>
        <section class="st-gate" aria-labelledby="st-gate-title">
          <div class="st-gate-card">
            <p class="st-kicker">Restricted archive</p>
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
              <button class="st-key-submit" type="submit">Decrypt archive</button>
              <p class="st-key-error" role="alert"></p>
            </form>
          </div>
        </section>
      </div>
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
        button.textContent = "Decrypt archive";
      }
    });
  }

  function isComplete(_subject, node) {
    if (node?.requiredWorks) {
      return (node.works?.length || 0) >= node.requiredWorks;
    }
    return node?.state === "accomplished";
  }

  function resolveParent(currentSubject, reference) {
    const separator = reference.indexOf(":");
    const subjectId = separator === -1 ? currentSubject.id : reference.slice(0, separator);
    const nodeId = separator === -1 ? reference : reference.slice(separator + 1);
    const subject = payload.subjects.find((candidate) => candidate.id === subjectId);
    const node = subject?.nodes.find((candidate) => candidate.id === nodeId);
    return { subject, node, external: subjectId !== currentSubject.id };
  }

  function isUnlocked(subject, node) {
    return node.parents.length === 0 || node.parents.every((reference) =>
      isComplete(subject, resolveParent(subject, reference).node)
    );
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
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });

    root.innerHTML = `
      <div class="st-app">
        <header class="st-site-header">
          <p class="st-wordmark">${payload.wordmark}</p>
          <p class="st-total-progress"></p>
        </header>
        <section class="st-directory" aria-labelledby="st-directory-title">
          <div class="st-directory-heading">
            <div>
              <p class="st-tree-index">Index</p>
              <h2 id="st-directory-title">Choose a discipline.</h2>
            </div>
            <p>${String(payload.subjects.length).padStart(2, "0")} fields of study</p>
          </div>
          <nav class="st-subject-tabs" aria-label="Skill disciplines"></nav>
        </section>
        <section class="st-study-area" id="st-study-area">
          <div class="st-tree-heading">
            <div>
              <p class="st-tree-index"></p>
              <h2></h2>
            </div>
            <div class="st-tree-heading-tools">
              <label class="st-subject-select-label">
                <span class="visually-hidden">Choose a discipline</span>
                <select class="st-subject-select"></select>
              </label>
              <p class="st-subject-progress"></p>
            </div>
          </div>
          <div class="st-progress-track" aria-hidden="true">
            <span class="st-progress-value"></span>
          </div>
          <div class="st-workspace st-tree-workspace">
            <section class="st-tree-panel">
              <div class="st-tree-group-tabs" role="group" aria-label="Trees within this discipline" hidden></div>
              <div class="st-tree-toolbar">
                <div class="st-status-legend" aria-label="Skill status legend">
                  <span><i class="is-accomplished"></i>${payload.labels.complete}</span>
                  <span><i class="is-available"></i>${payload.labels.available}</span>
                  <span><i class="is-future"></i>${payload.labels.locked}</span>
                </div>
                <p>${payload.labels.explore} &rarr;</p>
              </div>
              <div class="st-tree-scroll" tabindex="0" aria-label="Scrollable skill tree">
                <div class="st-tree-map">
                  <div class="st-tier-guides" aria-hidden="true"></div>
                  <svg class="st-connectors" aria-hidden="true"></svg>
                  <div class="st-tree-grid"></div>
                </div>
              </div>
            </section>
            <aside class="st-detail-panel" aria-live="polite"></aside>
          </div>
          <section class="st-timeline-workspace" aria-label="Shared timeline" hidden></section>
        </section>
        <footer class="st-footer">
          <p>&copy; 2026 ${payload.wordmark}</p>
        </footer>
      </div>
    `;

    renderTabs();
    renderSubjectSelect();
    renderSubject();
    updateTotalProgress();
  }

  function renderTabs() {
    const tabs = root.querySelector(".st-subject-tabs");
    tabs.replaceChildren();

    payload.subjects.forEach((subject, index) => {
      const tab = document.createElement("button");
      tab.className = "st-subject-tab";
      tab.type = "button";
      tab.id = `st-tab-${subject.id}`;
      tab.setAttribute("aria-pressed", String(subject.id === activeSubjectId));
      tab.innerHTML = `
        <span class="st-tab-index">${String(index + 1).padStart(2, "0")}</span>
        <span class="st-tab-name">${subject.name}</span>
        <span class="st-tab-progress">${subject.view === "timeline" && !subject.nodes.length ? "Timeline" : `${countCompleted(subject)} / ${subject.nodes.length}`}</span>
      `;
      tab.addEventListener("click", () => {
        activeSubjectId = subject.id;
        activeNodeId = null;
        activeTreeGroup = null;
        renderTabs();
        renderSubjectSelect();
        renderSubject();
        window.requestAnimationFrame(() => {
          root.querySelector(`#st-tab-${subject.id}`)?.focus({ preventScroll: true });
          root.querySelector("#st-study-area")?.scrollIntoView({
            behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
            block: "start",
          });
        });
      });
      tabs.append(tab);
    });
  }

  function renderSubjectSelect() {
    const select = root.querySelector(".st-subject-select");
    select.replaceChildren();

    payload.subjects.forEach((subject, index) => {
      const option = document.createElement("option");
      option.value = subject.id;
      option.textContent = `${String(index + 1).padStart(2, "0")} — ${subject.name}`;
      option.selected = subject.id === activeSubjectId;
      select.append(option);
    });

    select.onchange = () => {
      activeSubjectId = select.value;
      activeNodeId = null;
      activeTreeGroup = null;
      renderTabs();
      renderSubject();
    };
  }

  function renderSubject() {
    const subject = getActiveSubject();
    const subjectIndex = payload.subjects.indexOf(subject);
    const completedCount = countCompleted(subject);
    const percentage = subject.nodes.length ? (completedCount / subject.nodes.length) * 100 : 0;
    const heading = root.querySelector(".st-tree-heading h2");
    const index = root.querySelector(".st-study-area .st-tree-index");
    const progress = root.querySelector(".st-subject-progress");
    const progressValue = root.querySelector(".st-progress-value");
    const treeWorkspace = root.querySelector(".st-tree-workspace");
    const timelineWorkspace = root.querySelector(".st-timeline-workspace");

    heading.textContent = subject.name;
    index.textContent = `Discipline ${String(subjectIndex + 1).padStart(2, "0")}`;
    progress.textContent = `${completedCount} / ${subject.nodes.length} complete`;
    progressValue.style.setProperty("--progress", `${percentage}%`);

    if (subject.view === "timeline") {
      activeTreeGroup = null;
      treeWorkspace.hidden = true;
      timelineWorkspace.hidden = false;
      renderTimeline(subject);
      return;
    }

    treeWorkspace.hidden = false;
    timelineWorkspace.hidden = true;
    const treeGroups = subject.treeGroups || [];
    if (treeGroups.length && !treeGroups.some((group) => group.name === activeTreeGroup)) {
      activeTreeGroup = treeGroups[0].name;
    }
    if (!treeGroups.length) activeTreeGroup = null;
    const activeGroup = treeGroups.find((group) => group.name === activeTreeGroup);
    const visibleNodes = activeGroup
      ? subject.nodes.filter((node) => node.treeGroup === activeGroup.name)
      : subject.nodes;
    const visibleTierLabels = activeGroup?.tierLabels || subject.tierLabels;
    const visibleLaneCount = Math.max(3, ...visibleNodes.map((node) => node.lane));
    renderTreeGroupTabs(subject);
    const grid = root.querySelector(".st-tree-grid");
    const tierGuides = root.querySelector(".st-tier-guides");
    const map = root.querySelector(".st-tree-map");
    const scroller = root.querySelector(".st-tree-scroll");
    const viewKey = `${subject.id}:${activeTreeGroup || "all"}`;
    const subjectChanged = scroller.dataset.viewKey !== viewKey;
    const previousScroll = { left: scroller.scrollLeft, top: scroller.scrollTop };

    grid.id = "st-tree-grid";
    grid.setAttribute("aria-labelledby", `st-tab-${subject.id}`);
    grid.style.setProperty("--tier-count", visibleTierLabels.length);
    grid.style.setProperty("--lane-count", visibleLaneCount);
    grid.replaceChildren();
    tierGuides.style.setProperty("--tier-count", visibleTierLabels.length);
    map.style.width = `${visibleLaneCount * 166 + Math.max(0, visibleLaneCount - 1) * 80 + 162}px`;
    map.style.minHeight = `${76 + visibleTierLabels.length * 104 + Math.max(0, visibleTierLabels.length - 1) * 48}px`;
    tierGuides.innerHTML = visibleTierLabels
      .map((_label, tier) => `<span><b>${String(tier + 1).padStart(2, "0")}</b></span>`)
      .join("");

    visibleNodes.forEach((node, nodeIndex) => {
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
      button.innerHTML = `
        <span class="st-node-state">
          ${complete
            ? payload.labels.complete
            : node.requiredWorks
              ? `${node.works?.length || 0} / ${node.requiredWorks} ${node.progressLabel || "items"}`
              : unlocked ? payload.labels.available : payload.labels.locked}
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

    if (!activeNodeId || !visibleNodes.some((node) => node.id === activeNodeId)) {
      const nextNode = visibleNodes.find((node) => isUnlocked(subject, node) && !isComplete(subject, node));
      activeNodeId = (nextNode || visibleNodes.at(-1)).id;
      grid.querySelector(`[data-node-id="${activeNodeId}"]`)?.classList.add("is-selected");
    }

    scroller.dataset.viewKey = viewKey;
    if (subjectChanged) {
      window.requestAnimationFrame(() => {
        const selectedNode = grid.querySelector(`[data-node-id="${activeNodeId}"]`);
        if (selectedNode) {
          const scrollerBounds = scroller.getBoundingClientRect();
          const nodeBounds = selectedNode.getBoundingClientRect();
          const centerDelta = nodeBounds.left + nodeBounds.width / 2 -
            (scrollerBounds.left + scrollerBounds.width / 2);
          scroller.scrollLeft = Math.max(0, scroller.scrollLeft + centerDelta);
        } else {
          scroller.scrollLeft = Math.max(0, (scroller.scrollWidth - scroller.clientWidth) / 2);
        }
        scroller.scrollTop = 0;
      });
    } else {
      scroller.scrollTo(previousScroll);
    }
    renderDetails();
    scheduleConnectors();
  }

  function renderTreeGroupTabs(subject) {
    const tabs = root.querySelector(".st-tree-group-tabs");
    const treeGroups = subject.treeGroups || [];
    tabs.hidden = treeGroups.length < 2;
    tabs.replaceChildren();
    treeGroups.forEach((group, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.treeGroup = group.name;
      button.setAttribute("aria-pressed", String(group.name === activeTreeGroup));
      button.innerHTML = `<span>${String(index + 1).padStart(2, "0")}</span>${group.name}`;
      button.addEventListener("click", () => {
        activeTreeGroup = group.name;
        activeNodeId = null;
        renderSubject();
        window.requestAnimationFrame(() => {
          root
            .querySelector(`.st-tree-group-tabs [data-tree-group="${group.name}"]`)
            ?.focus({ preventScroll: true });
        });
      });
      tabs.append(button);
    });
  }

  function renderTimeline(activeSubject) {
    const timelineWorkspace = root.querySelector(".st-timeline-workspace");
    const heading = root.querySelector(".st-tree-heading h2");
    const index = root.querySelector(".st-study-area .st-tree-index");
    const progress = root.querySelector(".st-subject-progress");
    const timelineSubjects = payload.subjects.filter((subject) => subject.view === "timeline");
    const items = activeSubject.nodes
      .map((node) => ({ subject: activeSubject, node }))
      .sort((left, right) => left.node.timelineYear - right.node.timelineYear);
    const timelineRange = activeSubject.timelineRange || {
      minimumYear: -600,
      maximumYear: 2000,
      tickInterval: 500,
    };
    const minimumYear = timelineRange.minimumYear;
    const maximumYear = timelineRange.maximumYear;
    const yearSpan = maximumYear - minimumYear;
    const tickInterval = timelineRange.tickInterval;
    const minimumTickSpacing = tickInterval / 2;
    const firstInteriorTick = Math.ceil(minimumYear / tickInterval) * tickInterval;
    const lastInteriorTick = Math.floor(maximumYear / tickInterval) * tickInterval;
    const timelineTicks = [...new Set([
      minimumYear,
      ...Array.from(
        { length: Math.max(0, Math.floor((lastInteriorTick - firstInteriorTick) / tickInterval) + 1) },
        (_, tickIndex) => firstInteriorTick + tickIndex * tickInterval
      ),
      maximumYear,
    ])].filter((year) =>
      year === minimumYear || year === maximumYear ||
      (year - minimumYear >= minimumTickSpacing && maximumYear - year >= minimumTickSpacing)
    )
      .map((year) => ({
        position: (year - minimumYear) / yearSpan * 100,
        label: year < 0 ? `${Math.abs(year)} BCE` : year === 0 ? "1 CE" : String(year),
      }));
    const timelineRangeLabel = `${minimumYear < 0 ? `${Math.abs(minimumYear)} BCE` : minimumYear} to ${maximumYear} CE`;
    const activeCount = countCompleted(activeSubject);
    const compactTimeline = window.matchMedia("(max-width: 640px)").matches;

    heading.textContent = timelineSubjects.map((subject) => subject.name).join(" + ");
    index.textContent = "Shared chronology";
    progress.textContent = activeSubject.nodes.length
      ? `${activeSubject.name}: ${activeCount} / ${activeSubject.nodes.length} complete`
      : "";

    timelineWorkspace.id = "st-shared-timeline";
    timelineWorkspace.innerHTML = `
      <header class="st-timeline-toolbar">
        <div>
          <p class="st-tree-index">Shared timeline</p>
          <p>${activeSubject.name} lens · ${timelineRangeLabel}.</p>
        </div>
        <div class="st-timeline-toggles" role="group" aria-label="Choose a timeline discipline">
          ${timelineSubjects.map((subject) => `
            <button type="button" data-subject-id="${subject.id}" aria-pressed="${subject.id === activeSubject.id}">
              <span>${subject.name}</span>
              <small>${subject.nodes.length ? `${countCompleted(subject)} / ${subject.nodes.length}` : "No entries"}</small>
            </button>
          `).join("")}
        </div>
      </header>
      ${!activeSubject.nodes.length ? `
        <div class="st-timeline-empty" role="status">
          <p>No dated ${activeSubject.name.toLowerCase()} entries yet.</p>
          <span>Add dated entries in the private CSV when ready.</span>
        </div>
      ` : ""}
      <div class="st-timeline-scale" aria-label="Proportional ${activeSubject.name} timeline from ${timelineRangeLabel}">
        <div class="st-timeline-axis" aria-hidden="true">
          ${timelineTicks.map((tick) => `
            <span class="st-timeline-tick" style="--timeline-position: ${tick.position}%">${tick.label}</span>
          `).join("")}
        </div>
        ${items.map(({ subject, node }) => {
          const position = ((node.timelineYear - minimumYear) / yearSpan) * 100;
          return `
            <span
              class="st-timeline-marker is-highlighted"
              style="--timeline-position: ${position}%"
              data-timeline-key="${subject.id}:${node.id}"
              data-timeline-position="${position}"
              title="${node.title}, ${node.timelineYearLabel}"
              aria-hidden="true"
            ></span>
          `;
        }).join("")}
      </div>
      <div
        class="st-timeline-scroll"
        ${compactTimeline ? "" : `tabindex="0"`}
        aria-label="${compactTimeline ? "Chronological timeline" : "Horizontally scrollable chronological timeline"}"
      >
        <div class="st-timeline-map">
          <div class="st-timeline-plot">
            ${items.map(({ subject, node }) => {
              const worksStudied = node.works?.length || 0;
              const requiresWorks = Boolean(node.requiredWorks);
              const complete = isComplete(subject, node);
              return `
                <article
                  class="st-timeline-item is-highlighted${complete ? " is-complete" : ""}"
                  data-timeline-key="${subject.id}:${node.id}"
                  tabindex="0"
                >
                  <div class="st-timeline-card">
                    <div class="st-timeline-card-topline">
                      <span>${node.timelineYearLabel}</span>
                    </div>
                    <h3>${node.title}</h3>
                    <p class="st-timeline-description">${node.description}</p>
                    ${requiresWorks ? `
                      <div class="st-poet-progress">
                        <div><span>${complete ? "Complete" : "Study progress"}</span><strong>${Math.min(worksStudied, node.requiredWorks)} / ${node.requiredWorks}</strong></div>
                        <i style="--work-progress: ${Math.min(100, worksStudied / node.requiredWorks * 100)}%"></i>
                      </div>
                      <div class="st-studied-works">
                        ${worksStudied
                          ? `<ul>${node.works.map((work) => `<li>${work}</li>`).join("")}</ul>`
                          : `<p class="st-no-works">None recorded yet.</p>`}
                      </div>
                    ` : `<p class="st-timeline-state">${complete ? "Complete" : "Future"}</p>`}
                  </div>
                </article>
              `;
            }).join("")}
          </div>
        </div>
      </div>
    `;

    const linkedElements = [...timelineWorkspace.querySelectorAll("[data-timeline-key]")];
    const scale = timelineWorkspace.querySelector(".st-timeline-scale");
    const markers = linkedElements.filter((element) => element.classList.contains("st-timeline-marker"));
    let hoveredTimelineKey = null;
    let focusedTimelineKey = null;

    function updateTimelineLink() {
      linkedElements.forEach((element) => {
        const linked = element.dataset.timelineKey === hoveredTimelineKey ||
          element.dataset.timelineKey === focusedTimelineKey;
        element.classList.toggle("is-linked", linked);
      });
    }

    timelineWorkspace.querySelectorAll(".st-timeline-item").forEach((card) => {
      card.addEventListener("pointerenter", () => {
        hoveredTimelineKey = card.dataset.timelineKey;
        updateTimelineLink();
      });
      card.addEventListener("pointerleave", () => {
        if (hoveredTimelineKey === card.dataset.timelineKey) hoveredTimelineKey = null;
        updateTimelineLink();
      });
      card.addEventListener("focus", () => {
        focusedTimelineKey = card.dataset.timelineKey;
        updateTimelineLink();
      });
      card.addEventListener("blur", () => {
        if (focusedTimelineKey === card.dataset.timelineKey) focusedTimelineKey = null;
        updateTimelineLink();
      });
    });

    scale?.addEventListener("pointermove", (event) => {
      const bounds = scale.getBoundingClientRect();
      const pointerY = event.clientY - bounds.top;
      if (pointerY < 20 || pointerY > 55) {
        if (hoveredTimelineKey && markers.some((marker) => marker.dataset.timelineKey === hoveredTimelineKey)) {
          hoveredTimelineKey = null;
          updateTimelineLink();
        }
        return;
      }

      const pointerPosition = (event.clientX - bounds.left) / bounds.width * 100;
      const closest = markers.reduce((nearest, marker) => {
        const distance = Math.abs(Number(marker.dataset.timelinePosition) - pointerPosition);
        return !nearest || distance < nearest.distance ? { marker, distance } : nearest;
      }, null);
      const closeEnough = closest && closest.distance / 100 * bounds.width <= 14;
      hoveredTimelineKey = closeEnough ? closest.marker.dataset.timelineKey : null;
      updateTimelineLink();
    });
    scale?.addEventListener("pointerleave", () => {
      if (hoveredTimelineKey && markers.some((marker) => marker.dataset.timelineKey === hoveredTimelineKey)) {
        hoveredTimelineKey = null;
        updateTimelineLink();
      }
    });

    timelineWorkspace.querySelectorAll(".st-timeline-toggles button").forEach((button) => {
      button.addEventListener("click", () => {
        const nextSubjectId = button.dataset.subjectId;
        activeSubjectId = nextSubjectId;
        activeNodeId = null;
        activeTreeGroup = null;
        renderTabs();
        renderSubjectSelect();
        renderSubject();
        window.requestAnimationFrame(() => {
          timelineWorkspace
            .querySelector(`[data-subject-id="${nextSubjectId}"]`)
            ?.focus();
        });
      });
    });
  }

  function renderDetails() {
    const subject = getActiveSubject();
    const node = getActiveNode(subject);
    const visibleNodes = activeTreeGroup
      ? subject.nodes.filter((candidate) => candidate.treeGroup === activeTreeGroup)
      : subject.nodes;
    const nodeIndex = visibleNodes.indexOf(node);
    const complete = isComplete(subject, node);
    const unlocked = isUnlocked(subject, node);
    const panel = root.querySelector(".st-detail-panel");
    const resolvedParents = node.parents.map((reference) => resolveParent(subject, reference));
    const unmetParents = resolvedParents.filter(({ node: parent }) => !isComplete(subject, parent));

    panel.innerHTML = `
      <div class="st-detail-topline">
        <p class="st-detail-label">${node.tierLabel} / ${complete ? payload.labels.complete : unlocked ? payload.labels.available : payload.labels.locked}</p>
        <p class="st-detail-count">${String(nodeIndex + 1).padStart(2, "0")} / ${String(visibleNodes.length).padStart(2, "0")}</p>
      </div>
      <h3>${node.title}</h3>
      <p class="st-detail-description">${node.description}</p>
      <hr class="st-detail-rule">
      <p class="st-detail-label">${payload.labels.practice}</p>
      <p class="st-detail-practice">${node.practice}</p>
      ${node.requiredWorks ? `
        <div class="st-node-progress-record">
          <div><p class="st-detail-label">${node.progressLabel || "Progress"}</p><strong>${node.works?.length || 0} / ${node.requiredWorks}</strong></div>
          <i style="--node-progress: ${Math.min(100, (node.works?.length || 0) / node.requiredWorks * 100)}%"></i>
          <p>${node.works?.length ? node.works.join(" · ") : "None recorded yet."}</p>
        </div>
      ` : ""}
      ${resolvedParents.length ? `
        <div class="st-prerequisite-record">
          <p class="st-detail-label">Prerequisites</p>
          <p>${resolvedParents.map(({ subject: parentSubject, node: parent, external }) => external ? `${parentSubject.name} / ${parent.title}` : parent.title).join(" · ")}</p>
        </div>
      ` : ""}
      <div class="st-record-status">
        <p class="st-detail-label">${payload.labels.record}</p>
        <p>${node.requiredWorks
          ? complete
            ? `Completed automatically from ${node.works.length} recorded ${node.progressLabel || "items"}.`
            : `Completes automatically when ${node.requiredWorks} ${node.progressLabel || "items"} are recorded in the CSV.`
          : complete
            ? "Recorded as accomplished."
            : unlocked
              ? "Recorded as future. Prerequisites are accomplished."
              : "Recorded as future."}</p>
      </div>
      ${unmetParents.length ? `<p class="st-lock-note">${payload.labels.requires}: ${unmetParents.map(({ subject: parentSubject, node: parent, external }) => external ? `${parentSubject.name} / ${parent.title}` : parent.title).join(" + ")}</p>` : ""}
    `;
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

    const visibleNodes = activeTreeGroup
      ? subject.nodes.filter((node) => node.treeGroup === activeTreeGroup)
      : subject.nodes;
    visibleNodes.forEach((node) => {
      const childElement = map.querySelector(`[data-node-id="${node.id}"]`);
      if (!childElement) return;
      const childRect = childElement.getBoundingClientRect();

      node.parents.forEach((reference) => {
        const resolved = resolveParent(subject, reference);
        if (!resolved.node || resolved.subject?.id !== subject.id) return;
        const parent = resolved.node;
        const parentElement = [...map.querySelectorAll(".st-node")]
          .find((element) => element.dataset.nodeId === parent.id);
        if (!parentElement) return;
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

  window.addEventListener("resize", scheduleConnectors);
  showGate();
})();
