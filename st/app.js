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
  let activeAnalysisUrl = null;
  let historyFilterSubjectId = "";
  const earTrainerNotes = [
    { name: "A", octave: 4, frequency: 440 },
    { name: "A♯ / B♭", octave: 4, frequency: 466.16 },
    { name: "B", octave: 4, frequency: 493.88 },
    { name: "C", octave: 5, frequency: 523.25 },
    { name: "C♯ / D♭", octave: 5, frequency: 554.37 },
    { name: "D", octave: 5, frequency: 587.33 },
    { name: "D♯ / E♭", octave: 5, frequency: 622.25 },
    { name: "E", octave: 5, frequency: 659.25 },
    { name: "F", octave: 5, frequency: 698.46 },
    { name: "F♯ / G♭", octave: 5, frequency: 739.99 },
    { name: "G", octave: 5, frequency: 783.99 },
    { name: "G♯ / A♭", octave: 5, frequency: 830.61 },
  ];
  const earTrainerTimbres = [
    {
      name: "Grand piano",
      waveform: "sine",
      partials: [1, 0.58, 0.31, 0.17, 0.09],
      duration: 2.15,
      attack: 0.007,
      brightness: 0.72,
    },
    {
      name: "Acoustic guitar",
      waveform: "triangle",
      partials: [1, 0.64, 0.34, 0.19, 0.1],
      duration: 1.55,
      attack: 0.003,
      brightness: 0.56,
      pickNoise: true,
    },
    {
      name: "Electric piano",
      waveform: "sine",
      partials: [1, 0.36, 0.18, 0.25, 0.08],
      duration: 2.35,
      attack: 0.012,
      brightness: 0.66,
    },
  ];

  function bytesFromBase64(value) {
    const decoded = window.atob(value);
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  }

  function releaseAnalysisDocument() {
    const frame = root.querySelector(".st-analysis-frame");
    if (frame) frame.src = "about:blank";
    if (activeAnalysisUrl) window.URL.revokeObjectURL(activeAnalysisUrl);
    activeAnalysisUrl = null;
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
      const worksComplete = (node.works?.length || 0) >= node.requiredWorks;
      return worksComplete && (!node.requiresAnalysis || node.analysisComplete);
    }
    return node?.state === "accomplished";
  }

  function getStudyProgress(node) {
    const worksTarget = node.requiredWorks || 0;
    const worksComplete = Math.min(node.works?.length || 0, worksTarget);
    const analysisTarget = node.requiresAnalysis ? 1 : 0;
    const analysisComplete = node.analysisComplete ? 1 : 0;
    return {
      completed: worksComplete + analysisComplete,
      total: worksTarget + analysisTarget,
    };
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

  function getSubjectNumber(subject) {
    const subjectIndex = payload.subjects.indexOf(subject);
    return payload.subjects
      .slice(0, subjectIndex + 1)
      .filter((candidate) => !candidate.unnumbered)
      .length;
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

  function formatProgressDate(value) {
    const [year, month, day] = value.split("-").map(Number);
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(new Date(year, month - 1, day));
  }

  function findSubjectEntry(subject, entryId) {
    return subject?.nodes.find((candidate) => candidate.id === entryId) ||
      subject?.repeatables?.find((candidate) => candidate.id === entryId);
  }

  function isRepeatableEntry(subject, entry) {
    return Boolean(subject?.repeatables?.some((candidate) => candidate.id === entry?.id));
  }

  function formatHistoryProgress(event) {
    if (event.repeatable) return `${event.completed}×`;
    if (event.completed === null) return "Completed";
    return `${event.completed} / ${event.total}`;
  }

  function navigateToEntry(subject, node) {
    const repeatable = isRepeatableEntry(subject, node);
    activeSubjectId = subject.id;
    activeNodeId = repeatable ? null : node.id;
    activeTreeGroup = repeatable ? null : node.treeGroup || null;
    renderTabs();
    renderSubjectSelect();
    renderSubject();

    window.requestAnimationFrame(() => {
      const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
      if (subject.view === "timeline") {
        const key = `${subject.id}:${node.id}`;
        const card = root.querySelector(`.st-timeline-item[data-timeline-key="${key}"]`);
        card?.focus({ preventScroll: true });
        card?.scrollIntoView({ behavior, block: "center", inline: "center" });
        return;
      }
      if (repeatable) {
        const item = root.querySelector(`.st-repeatable-item[data-repeatable-id="${node.id}"]`);
        item?.focus({ preventScroll: true });
        item?.scrollIntoView({ behavior, block: "center" });
        return;
      }
      const skill = root.querySelector(`.st-node[data-node-id="${node.id}"]`);
      skill?.focus({ preventScroll: true });
      skill?.scrollIntoView({ behavior, block: "center", inline: "center" });
    });
  }

  function setupHistory() {
    const trigger = root.querySelector(".st-history-trigger");
    const overlay = root.querySelector(".st-history-overlay");
    const dialog = root.querySelector(".st-history-dialog");
    const closeButton = root.querySelector(".st-history-close");
    const backdrop = root.querySelector(".st-history-backdrop");
    const filter = root.querySelector(".st-history-filter");
    const list = root.querySelector(".st-history-list");

    function entries() {
      const resolved = (payload.history || []).map((event, eventIndex) => {
        const subject = payload.subjects.find((candidate) => candidate.id === event.subjectId);
        const node = findSubjectEntry(subject, event.nodeId);
        return subject && node ? { event, eventIndex, subject, node } : null;
      }).filter(Boolean);

      return resolved
        .filter(({ subject }) => !historyFilterSubjectId || subject.id === historyFilterSubjectId)
        .sort((left, right) =>
          right.event.date.localeCompare(left.event.date) || right.eventIndex - left.eventIndex
        );
    }

    function renderHistoryList() {
      const historyEntries = entries();
      list.innerHTML = historyEntries.length ? historyEntries.map(({ event, eventIndex, subject, node }) => `
        <button
          type="button"
          class="st-history-row"
          data-history-index="${eventIndex}"
          aria-label="${subject.name}, ${node.title}, ${formatHistoryProgress(event)}, ${formatProgressDate(event.date)}"
        >
          <span class="st-history-subject">${subject.name}</span>
          <span class="st-history-skill">${node.title}</span>
          <strong>${formatHistoryProgress(event)}</strong>
          <time datetime="${event.date}">${formatProgressDate(event.date)}</time>
        </button>
      `).join("") : `<p class="st-history-empty">${historyFilterSubjectId
        ? `No ${payload.subjects.find((subject) => subject.id === historyFilterSubjectId)?.name || "subject"} progress has been recorded yet.`
        : "No progress has been recorded yet."}</p>`;

      list.querySelectorAll(".st-history-row").forEach((row) => {
        row.addEventListener("click", () => {
          const event = payload.history[Number(row.dataset.historyIndex)];
          const subject = payload.subjects.find((candidate) => candidate.id === event.subjectId);
          const node = findSubjectEntry(subject, event.nodeId);
          if (!subject || !node) return;
          closeHistory({ restoreFocus: false });
          navigateToEntry(subject, node);
        });
      });
    }

    function openHistory() {
      const searchOverlay = root.querySelector(".st-search-overlay");
      if (!searchOverlay?.hidden) root.querySelector(".st-search-trigger")?.click();
      const earOverlay = root.querySelector(".st-ear-overlay");
      if (!earOverlay?.hidden) root.querySelector(".st-ear-trigger")?.click();
      renderHistoryList();
      filter.value = historyFilterSubjectId;
      overlay.hidden = false;
      trigger.setAttribute("aria-expanded", "true");
      trigger.setAttribute("aria-label", "Close progress history");
      document.body.classList.add("st-history-open");
      list.scrollTop = 0;
      window.requestAnimationFrame(() => closeButton.focus({ preventScroll: true }));
    }

    function closeHistory({ restoreFocus = true } = {}) {
      overlay.hidden = true;
      trigger.setAttribute("aria-expanded", "false");
      trigger.setAttribute("aria-label", "Open progress history");
      document.body.classList.remove("st-history-open");
      if (restoreFocus) trigger.focus({ preventScroll: true });
    }

    trigger.addEventListener("click", () => {
      if (overlay.hidden) openHistory();
      else closeHistory();
    });
    closeButton.addEventListener("click", () => closeHistory());
    backdrop.addEventListener("click", () => closeHistory());
    filter.addEventListener("change", () => {
      historyFilterSubjectId = filter.value;
      renderHistoryList();
    });
    overlay.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeHistory();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...dialog.querySelectorAll("button:not([disabled]), select:not([disabled])")];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
  }

  function setupSearch() {
    const trigger = root.querySelector(".st-search-trigger");
    const overlay = root.querySelector(".st-search-overlay");
    const dialog = root.querySelector(".st-search-dialog");
    const closeButton = root.querySelector(".st-search-close");
    const backdrop = root.querySelector(".st-search-backdrop");
    const input = root.querySelector(".st-search-input");
    const list = root.querySelector(".st-search-list");
    const summary = root.querySelector(".st-search-summary");
    const resultLimit = 60;
    const searchEntries = payload.subjects.flatMap((subject) =>
      [...subject.nodes, ...(subject.repeatables || [])].map((node) => ({
        subject,
        node,
        normalizedTitle: normalizeSearchText(node.title),
        normalizedSubject: normalizeSearchText(subject.name),
        haystack: normalizeSearchText([
          subject.name,
          node.title,
          node.description,
          node.practice,
          node.treeGroup,
          ...(node.works || []),
          ...(node.recommendedWorks || []),
          ...(node.extraWorks || []),
        ].filter(Boolean).join(" ")),
      }))
    );

    function normalizeSearchText(value) {
      return String(value || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLocaleLowerCase()
        .replace(/\s+/g, " ")
        .trim();
    }

    function escapeSearchMarkup(value) {
      return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
    }

    function resultMeta(subject, node) {
      if (isRepeatableEntry(subject, node)) {
        return node.count ? `${node.count}× recorded` : "Repeatable";
      }
      if (subject.view === "timeline") {
        const progress = getStudyProgress(node);
        return `${progress.completed} / ${progress.total} studied`;
      }
      if (isComplete(subject, node)) return payload.labels.complete;
      return isUnlocked(subject, node) ? payload.labels.available : payload.labels.locked;
    }

    function matches(query) {
      if (!query) return [];
      return searchEntries
        .filter((entry) => entry.haystack.includes(query))
        .map((entry) => {
          let score = 5;
          if (entry.normalizedTitle === query) score = 0;
          else if (entry.normalizedTitle.startsWith(query)) score = 1;
          else if (entry.normalizedTitle.includes(query)) score = 2;
          else if (entry.normalizedSubject === query) score = 3;
          else if (entry.normalizedSubject.includes(query)) score = 4;
          return { ...entry, score };
        })
        .sort((left, right) =>
          left.score - right.score ||
          left.subject.name.localeCompare(right.subject.name) ||
          left.node.title.localeCompare(right.node.title)
        );
    }

    function renderSearchResults() {
      const query = normalizeSearchText(input.value);
      const results = matches(query);
      const visibleResults = results.slice(0, resultLimit);

      if (!query) {
        summary.textContent = "Search every discipline, skill, person, work, and course.";
        list.innerHTML = `
          <div class="st-search-empty">
            <span>Begin typing to search the archive.</span>
            <small>Titles and disciplines are ranked first.</small>
          </div>
        `;
        return;
      }

      summary.textContent = results.length
        ? `${results.length} ${results.length === 1 ? "result" : "results"}${results.length > resultLimit ? ` · showing first ${resultLimit}` : ""}`
        : "No results";
      list.innerHTML = visibleResults.length ? visibleResults.map(({ subject, node }) => `
        <button
          type="button"
          class="st-search-result"
          data-subject-id="${escapeSearchMarkup(subject.id)}"
          data-node-id="${escapeSearchMarkup(node.id)}"
          aria-label="${escapeSearchMarkup(`${node.title}, ${subject.name}, ${resultMeta(subject, node)}`)}"
        >
          <span class="st-search-subject">${escapeSearchMarkup(subject.name)}</span>
          <span class="st-search-title">${escapeSearchMarkup(node.title)}</span>
          <span class="st-search-meta">${escapeSearchMarkup(resultMeta(subject, node))}</span>
        </button>
      `).join("") : `
        <div class="st-search-empty">
          <span>Nothing matched that search.</span>
          <small>Try a discipline, course, person, work, or shorter phrase.</small>
        </div>
      `;

      list.querySelectorAll(".st-search-result").forEach((result) => {
        result.addEventListener("click", () => {
          const subject = payload.subjects.find((candidate) => candidate.id === result.dataset.subjectId);
          const node = findSubjectEntry(subject, result.dataset.nodeId);
          if (!subject || !node) return;
          closeSearch({ restoreFocus: false });
          navigateToEntry(subject, node);
        });
      });
    }

    function closeHistoryIfOpen() {
      const historyOverlay = root.querySelector(".st-history-overlay");
      const historyTrigger = root.querySelector(".st-history-trigger");
      if (!historyOverlay?.hidden) historyTrigger?.click();
    }

    function closeEarTrainerIfOpen() {
      const earOverlay = root.querySelector(".st-ear-overlay");
      const earTrigger = root.querySelector(".st-ear-trigger");
      if (!earOverlay?.hidden) earTrigger?.click();
    }

    function openSearch() {
      closeHistoryIfOpen();
      closeEarTrainerIfOpen();
      overlay.hidden = false;
      trigger.setAttribute("aria-expanded", "true");
      trigger.setAttribute("aria-label", "Close search");
      document.body.classList.add("st-search-open");
      renderSearchResults();
      list.scrollTop = 0;
      window.requestAnimationFrame(() => input.focus({ preventScroll: true }));
    }

    function closeSearch({ restoreFocus = true } = {}) {
      overlay.hidden = true;
      trigger.setAttribute("aria-expanded", "false");
      trigger.setAttribute("aria-label", "Open search");
      document.body.classList.remove("st-search-open");
      input.value = "";
      renderSearchResults();
      if (restoreFocus) trigger.focus({ preventScroll: true });
    }

    trigger.addEventListener("click", () => {
      if (overlay.hidden) openSearch();
      else closeSearch();
    });
    closeButton.addEventListener("click", () => closeSearch());
    backdrop.addEventListener("click", () => closeSearch());
    input.addEventListener("input", renderSearchResults);
    input.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown") {
        const firstResult = list.querySelector(".st-search-result");
        if (firstResult) {
          event.preventDefault();
          firstResult.focus();
        }
      }
    });
    overlay.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeSearch();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [
        ...dialog.querySelectorAll("input:not([disabled]), button:not([disabled])"),
      ];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });

    renderSearchResults();
  }

  function setupEarTrainer() {
    const trigger = root.querySelector(".st-ear-trigger");
    const overlay = root.querySelector(".st-ear-overlay");
    const dialog = root.querySelector(".st-ear-dialog");
    const closeButton = root.querySelector(".st-ear-close");
    const backdrop = root.querySelector(".st-ear-backdrop");
    const playButton = root.querySelector(".st-ear-play");
    const noteButtons = [...root.querySelectorAll(".st-ear-note")];
    const status = root.querySelector(".st-ear-status");
    const source = root.querySelector(".st-ear-source");
    const streakValue = root.querySelector(".st-ear-streak strong");
    if (!trigger || !overlay || !dialog || !closeButton || !backdrop ||
        !playButton || !status || !source || !streakValue || !noteButtons.length) return;

    let audioContext = null;
    let activeSources = [];
    let targetNoteIndex = null;
    let targetTimbre = null;
    let awaitingGuess = false;
    let roundAnswered = false;
    let streak = 0;

    function chooseRandom(items) {
      return items[Math.floor(Math.random() * items.length)];
    }

    function getAudioContext() {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return null;
      if (!audioContext) audioContext = new AudioContextClass();
      return audioContext;
    }

    function stopActiveTone() {
      if (!audioContext) return;
      const stopAt = audioContext.currentTime + 0.015;
      activeSources.forEach((audioSource) => {
        try {
          audioSource.stop(stopAt);
        } catch (_error) {
          // A completed oscillator cannot be stopped twice.
        }
      });
      activeSources = [];
    }

    async function playTone(note, timbre) {
      const context = getAudioContext();
      if (!context) {
        status.textContent = "This browser does not support the audio engine.";
        return false;
      }

      try {
        if (context.state === "suspended") await context.resume();
      } catch (_error) {
        status.textContent = "Audio is unavailable. Check this browser's sound permissions.";
        return false;
      }

      stopActiveTone();
      const now = context.currentTime;
      const master = context.createGain();
      const brightness = context.createBiquadFilter();
      brightness.type = "lowpass";
      brightness.frequency.setValueAtTime(3600 + timbre.brightness * 3600, now);
      brightness.Q.setValueAtTime(0.4, now);
      master.gain.setValueAtTime(0.82, now);
      master.connect(brightness);
      brightness.connect(context.destination);

      const partialTotal = timbre.partials.reduce((sum, value) => sum + value, 0);
      timbre.partials.forEach((partial, partialIndex) => {
        const harmonic = partialIndex + 1;
        const oscillator = context.createOscillator();
        const envelope = context.createGain();
        const peak = 0.42 * (partial / partialTotal);
        const harmonicDuration = timbre.duration * Math.max(0.4, 1 - partialIndex * 0.13);

        oscillator.type = partialIndex === 0 ? timbre.waveform : "sine";
        oscillator.frequency.setValueAtTime(note.frequency * harmonic, now);
        oscillator.detune.setValueAtTime((Math.random() - 0.5) * 1.4, now);
        envelope.gain.setValueAtTime(0.0001, now);
        envelope.gain.linearRampToValueAtTime(peak, now + timbre.attack);
        envelope.gain.exponentialRampToValueAtTime(0.0001, now + harmonicDuration);
        oscillator.connect(envelope);
        envelope.connect(master);
        oscillator.start(now);
        oscillator.stop(now + harmonicDuration + 0.05);
        activeSources.push(oscillator);
      });

      if (timbre.pickNoise) {
        const noiseLength = Math.floor(context.sampleRate * 0.035);
        const noiseBuffer = context.createBuffer(1, noiseLength, context.sampleRate);
        const noiseData = noiseBuffer.getChannelData(0);
        for (let index = 0; index < noiseLength; index += 1) {
          noiseData[index] = (Math.random() * 2 - 1) * (1 - index / noiseLength);
        }
        const pick = context.createBufferSource();
        const pickFilter = context.createBiquadFilter();
        const pickGain = context.createGain();
        pick.buffer = noiseBuffer;
        pickFilter.type = "bandpass";
        pickFilter.frequency.setValueAtTime(Math.min(note.frequency * 3.4, 5200), now);
        pickFilter.Q.setValueAtTime(0.8, now);
        pickGain.gain.setValueAtTime(0.16, now);
        pickGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.035);
        pick.connect(pickFilter);
        pickFilter.connect(pickGain);
        pickGain.connect(master);
        pick.start(now);
        pick.stop(now + 0.04);
        activeSources.push(pick);
      }

      return true;
    }

    function clearFeedback() {
      noteButtons.forEach((button) => button.classList.remove("is-correct", "is-wrong"));
    }

    function updateStreak() {
      streakValue.textContent = String(streak);
    }

    function closeOtherUtilities() {
      const historyOverlay = root.querySelector(".st-history-overlay");
      if (!historyOverlay?.hidden) root.querySelector(".st-history-trigger")?.click();
      const searchOverlay = root.querySelector(".st-search-overlay");
      if (!searchOverlay?.hidden) root.querySelector(".st-search-trigger")?.click();
    }

    function openEarTrainer() {
      closeOtherUtilities();
      overlay.hidden = false;
      trigger.setAttribute("aria-expanded", "true");
      trigger.setAttribute("aria-label", "Close ear trainer");
      document.body.classList.add("st-ear-open");
      window.requestAnimationFrame(() => playButton.focus({ preventScroll: true }));
    }

    function closeEarTrainer({ restoreFocus = true } = {}) {
      overlay.hidden = true;
      trigger.setAttribute("aria-expanded", "false");
      trigger.setAttribute("aria-label", "Open ear trainer");
      document.body.classList.remove("st-ear-open");
      stopActiveTone();
      targetNoteIndex = null;
      targetTimbre = null;
      awaitingGuess = false;
      roundAnswered = false;
      clearFeedback();
      source.textContent = "Three synthesized instruments are chosen at random each round.";
      status.textContent = "Press Play to hear a mystery note, then choose the pitch below.";
      if (restoreFocus) trigger.focus({ preventScroll: true });
    }

    playButton.addEventListener("click", async () => {
      clearFeedback();
      const beginsNewRound = !awaitingGuess;
      if (beginsNewRound) {
        targetNoteIndex = Math.floor(Math.random() * earTrainerNotes.length);
        targetTimbre = chooseRandom(earTrainerTimbres);
        awaitingGuess = true;
        roundAnswered = false;
      }

      const note = earTrainerNotes[targetNoteIndex];
      source.textContent = `Source: ${targetTimbre.name}`;
      const played = await playTone(note, targetTimbre);
      if (!played) return;
      status.textContent = beginsNewRound
        ? "Listen carefully, then choose the note."
        : "The same mystery note was replayed.";
    });

    noteButtons.forEach((button) => {
      button.addEventListener("click", async () => {
        const noteIndex = Number(button.dataset.noteIndex);
        const note = earTrainerNotes[noteIndex];
        if (!note) return;

        if (roundAnswered) {
          clearFeedback();
          targetNoteIndex = null;
          targetTimbre = null;
          awaitingGuess = false;
          roundAnswered = false;
        }

        const isGuess = awaitingGuess;
        if (isGuess) awaitingGuess = false;
        const timbre = isGuess ? targetTimbre : chooseRandom(earTrainerTimbres);
        source.textContent = `Source: ${timbre.name}`;
        const played = await playTone(note, timbre);
        if (!played) {
          if (isGuess) awaitingGuess = true;
          return;
        }

        if (!isGuess) {
          status.textContent = `${note.name} · ${note.frequency.toFixed(2)} Hz`;
          return;
        }

        roundAnswered = true;
        const correctButton = noteButtons[targetNoteIndex];
        const targetNote = earTrainerNotes[targetNoteIndex];

        if (noteIndex === targetNoteIndex) {
          streak += 1;
          button.classList.add("is-correct");
          status.textContent = `Correct — ${targetNote.name} at ${targetNote.frequency.toFixed(2)} Hz. Press Play for the next note.`;
        } else {
          streak = 0;
          button.classList.add("is-wrong");
          correctButton?.classList.add("is-correct");
          status.textContent = `Not quite — the note was ${targetNote.name} at ${targetNote.frequency.toFixed(2)} Hz. Press Play to continue.`;
        }
        updateStreak();
      });
    });

    trigger.addEventListener("click", () => {
      if (overlay.hidden) openEarTrainer();
      else closeEarTrainer();
    });
    closeButton.addEventListener("click", () => closeEarTrainer());
    backdrop.addEventListener("click", () => closeEarTrainer());
    overlay.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeEarTrainer();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...dialog.querySelectorAll("button:not([disabled])")];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });

    updateStreak();
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
          <div class="st-header-actions">
            <button
              type="button"
              class="st-history-trigger"
              aria-label="Open progress history"
              aria-controls="st-history-overlay"
              aria-expanded="false"
              title="Progress history"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M5 3.5h14v17H5zM8 3.5v17M11 8h5M11 12h5M11 16h4"></path>
              </svg>
            </button>
            <button
              type="button"
              class="st-search-trigger"
              aria-label="Open search"
              aria-controls="st-search-overlay"
              aria-expanded="false"
              title="Search"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="10.5" cy="10.5" r="5.75"></circle>
                <path d="m14.75 14.75 4.5 4.5"></path>
              </svg>
            </button>
            <button
              type="button"
              class="st-ear-trigger"
              aria-label="Open ear trainer"
              aria-controls="st-ear-overlay"
              aria-expanded="false"
              title="Ear trainer"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M9 17.5V5.5l10-2v12"></path>
                <path d="M9 8.5l10-2"></path>
                <ellipse class="st-ear-note-head" cx="6.25" cy="18" rx="2.75" ry="2"></ellipse>
                <ellipse class="st-ear-note-head" cx="16.25" cy="16" rx="2.75" ry="2"></ellipse>
              </svg>
            </button>
          </div>
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
          <section class="st-repeatable-panel" aria-label="Repeatable goals" hidden></section>
          <section class="st-timeline-workspace" aria-label="Shared timeline" hidden></section>
        </section>
        <footer class="st-footer">
          <p>&copy; 2026 ${payload.wordmark}</p>
        </footer>
      </div>
      <div class="st-history-overlay" id="st-history-overlay" hidden>
        <button class="st-history-backdrop" type="button" tabindex="-1" aria-label="Close progress history"></button>
        <section class="st-history-dialog" role="dialog" aria-modal="true" aria-labelledby="st-history-title">
          <header class="st-history-header">
            <div>
              <p class="st-tree-index">Progress archive</p>
              <h2 id="st-history-title">History</h2>
            </div>
            <div class="st-history-tools">
              <label>
                <span>Filter by</span>
                <select class="st-history-filter" aria-label="Filter progress history by subject">
                  <option value="">All subjects</option>
                  ${payload.subjects.map((subject) => `<option value="${subject.id}">${subject.name}</option>`).join("")}
                </select>
              </label>
              <button class="st-history-close" type="button" aria-label="Close progress history">&times;</button>
            </div>
          </header>
          <div class="st-history-columns" aria-hidden="true">
            <span>Subject</span><span>Skill or subject</span><span>Progress</span><span>Date</span>
          </div>
          <div class="st-history-list"></div>
        </section>
      </div>
      <div class="st-search-overlay" id="st-search-overlay" hidden>
        <button class="st-search-backdrop" type="button" tabindex="-1" aria-label="Close search"></button>
        <section class="st-search-dialog" role="dialog" aria-modal="true" aria-labelledby="st-search-title">
          <header class="st-search-header">
            <div>
              <p class="st-tree-index">Find anything</p>
              <h2 id="st-search-title">Search</h2>
            </div>
            <button class="st-search-close" type="button" aria-label="Close search">&times;</button>
          </header>
          <label class="st-search-field">
            <span class="visually-hidden">Search the archive</span>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="10.5" cy="10.5" r="5.75"></circle>
              <path d="m14.75 14.75 4.5 4.5"></path>
            </svg>
            <input
              class="st-search-input"
              type="search"
              inputmode="search"
              autocomplete="off"
              autocapitalize="none"
              spellcheck="false"
              placeholder="Search skills, people, works, or courses"
            >
          </label>
          <p class="st-search-summary" aria-live="polite"></p>
          <div class="st-search-list"></div>
        </section>
      </div>
      <div class="st-ear-overlay" id="st-ear-overlay" hidden>
        <button class="st-ear-backdrop" type="button" tabindex="-1" aria-label="Close ear trainer"></button>
        <section class="st-ear-dialog" role="dialog" aria-modal="true" aria-labelledby="st-ear-title">
          <header class="st-ear-header">
            <div>
              <p class="st-tree-index">Pitch recognition</p>
              <h2 id="st-ear-title">Ear trainer</h2>
            </div>
            <div class="st-ear-header-tools">
              <p class="st-ear-streak"><span>Correct in a row</span><strong>0</strong></p>
              <button class="st-ear-close" type="button" aria-label="Close ear trainer">&times;</button>
            </div>
          </header>
          <div class="st-ear-stage">
            <div class="st-ear-range">
              <p>A4 to G♯5 / A♭5</p>
              <span>One chromatic octave · A4 = 440 Hz</span>
            </div>
            <button class="st-ear-play" type="button">
              <span>Play</span>
              <small>New note or replay the current note</small>
            </button>
            <p class="st-ear-source">Three synthesized instruments are chosen at random each round.</p>
            <p class="st-ear-status" aria-live="polite">Press Play to hear a mystery note, then choose the pitch below.</p>
          </div>
          <div class="st-ear-note-grid" aria-label="Chromatic note choices">
            ${earTrainerNotes.map((note, noteIndex) => `
              <button
                class="st-ear-note"
                type="button"
                data-note-index="${noteIndex}"
                aria-label="${note.name.replace(" / ", " or ")}, octave ${note.octave}, ${note.frequency.toFixed(2)} hertz"
              >
                <strong>${note.name}</strong>
                <small>${note.frequency.toFixed(2)} Hz</small>
              </button>
            `).join("")}
          </div>
          <p class="st-ear-footnote">Every note button can also be used independently to audition its pitch.</p>
        </section>
      </div>
    `;

    setupHistory();
    setupSearch();
    setupEarTrainer();
    renderTabs();
    renderSubjectSelect();
    renderSubject();
    updateTotalProgress();
  }

  function renderTabs() {
    const tabs = root.querySelector(".st-subject-tabs");
    tabs.replaceChildren();

    payload.subjects.forEach((subject) => {
      const subjectNumber = getSubjectNumber(subject);
      const tab = document.createElement("button");
      tab.className = `st-subject-tab${subject.unnumbered ? " is-standalone" : ""}`;
      tab.type = "button";
      tab.id = `st-tab-${subject.id}`;
      tab.setAttribute("aria-pressed", String(subject.id === activeSubjectId));
      tab.innerHTML = `
        ${subject.unnumbered ? "" : `<span class="st-tab-index">${String(subjectNumber).padStart(2, "0")}</span>`}
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

    payload.subjects.forEach((subject) => {
      const subjectNumber = getSubjectNumber(subject);
      const option = document.createElement("option");
      option.value = subject.id;
      option.textContent = subject.unnumbered
        ? subject.name
        : `${String(subjectNumber).padStart(2, "0")} — ${subject.name}`;
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
    releaseAnalysisDocument();
    const subject = getActiveSubject();
    const subjectNumber = getSubjectNumber(subject);
    const completedCount = countCompleted(subject);
    const percentage = subject.nodes.length ? (completedCount / subject.nodes.length) * 100 : 0;
    const heading = root.querySelector(".st-tree-heading h2");
    const index = root.querySelector(".st-study-area .st-tree-index");
    const progress = root.querySelector(".st-subject-progress");
    const progressValue = root.querySelector(".st-progress-value");
    const treeWorkspace = root.querySelector(".st-tree-workspace");
    const timelineWorkspace = root.querySelector(".st-timeline-workspace");
    const repeatablePanel = root.querySelector(".st-repeatable-panel");

    heading.textContent = subject.name;
    index.textContent = subject.unnumbered
      ? "Independent field"
      : `Discipline ${String(subjectNumber).padStart(2, "0")}`;
    progress.textContent = `${completedCount} / ${subject.nodes.length} complete`;
    progressValue.style.setProperty("--progress", `${percentage}%`);

    if (subject.view === "timeline") {
      activeTreeGroup = null;
      treeWorkspace.hidden = true;
      repeatablePanel.hidden = true;
      repeatablePanel.replaceChildren();
      timelineWorkspace.hidden = false;
      renderTimeline(subject);
      return;
    }

    treeWorkspace.hidden = false;
    timelineWorkspace.hidden = true;
    renderRepeatables(subject);
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

  function renderRepeatables(subject) {
    const panel = root.querySelector(".st-repeatable-panel");
    const entries = subject.repeatables || [];
    panel.replaceChildren();
    panel.hidden = entries.length === 0;
    if (!entries.length) return;

    const groups = [...new Set(entries.map((entry) => entry.group))];
    panel.innerHTML = groups.map((group) => {
      const groupEntries = entries.filter((entry) => entry.group === group);
      const level = groupEntries.reduce((sum, entry) => sum + entry.count, 0);
      return `
        <article class="st-repeatable-group">
          <header class="st-repeatable-header">
            <div>
              <p class="st-tree-index">Repeatable practice</p>
              <h3>${group}</h3>
              <p>Every dated completion adds one level. Counts remain read-only here and are maintained in the private CSV.</p>
            </div>
            <div class="st-repeatable-level" aria-label="${group} skill level ${level}">
              <span>${group} skill</span>
              <strong>Level ${level}</strong>
            </div>
          </header>
          <div class="st-repeatable-grid">
            ${groupEntries.map((entry, index) => `
              <section
                class="st-repeatable-item"
                data-repeatable-id="${entry.id}"
                tabindex="0"
                aria-label="${entry.title}, completed ${entry.count} times"
              >
                <div class="st-repeatable-item-topline">
                  <span>${String(index + 1).padStart(2, "0")}</span>
                  <strong>${entry.count}&times;</strong>
                </div>
                <h4>${entry.title}</h4>
                <p>${entry.description}</p>
              </section>
            `).join("")}
          </div>
        </article>
      `;
    }).join("");
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
      minimumYear: -650,
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
    const timelineEras = (activeSubject.timelineEras || []).map((era) => ({
      ...era,
      position: (era.startYear - minimumYear) / yearSpan * 100,
      width: (era.endYear - era.startYear) / yearSpan * 100,
    }));
    const timelineRangeLabel = `${minimumYear < 0 ? `${Math.abs(minimumYear)} BCE` : minimumYear} to ${maximumYear} CE`;
    const activeCount = countCompleted(activeSubject);
    const compactTimeline = window.matchMedia("(max-width: 640px)").matches;
    const markerSeparation = compactTimeline ? 4 : 1.35;
    const lastMarkerPositionByRow = [-Infinity, -Infinity];
    const markerRows = new Map();

    items.forEach(({ subject, node }) => {
      const position = ((node.timelineYear - minimumYear) / yearSpan) * 100;
      let markerRow = lastMarkerPositionByRow.findIndex(
        (lastPosition) => position - lastPosition >= markerSeparation
      );
      if (markerRow === -1) {
        markerRow = lastMarkerPositionByRow[0] <= lastMarkerPositionByRow[1] ? 0 : 1;
      }
      lastMarkerPositionByRow[markerRow] = position;
      markerRows.set(`${subject.id}:${node.id}`, markerRow);
    });

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
        ${timelineEras.length ? `
          <div class="st-timeline-eras" aria-label="${activeSubject.name} eras">
            ${timelineEras.map((era) => `
              <span
                class="st-timeline-era"
                style="--era-position: ${era.position}%; --era-width: ${era.width}%"
                title="${era.label}"
              ><b>${era.label}</b></span>
            `).join("")}
          </div>
        ` : ""}
        <div class="st-timeline-axis" aria-hidden="true">
          ${timelineTicks.map((tick) => `
            <span class="st-timeline-tick" style="--timeline-position: ${tick.position}%">${tick.label}</span>
          `).join("")}
        </div>
        ${items.map(({ subject, node }) => {
          const position = ((node.timelineYear - minimumYear) / yearSpan) * 100;
          const timelineKey = `${subject.id}:${node.id}`;
          return `
            <button
              type="button"
              class="st-timeline-marker is-highlighted${isComplete(subject, node) ? " is-complete" : ""}"
              style="--timeline-position: ${position}%; --marker-row: ${markerRows.get(timelineKey)}"
              data-timeline-key="${timelineKey}"
              data-timeline-position="${position}"
              title="${node.title}, ${node.timelineYearLabel}"
              aria-label="Show ${node.title}, ${node.timelineYearLabel} in the subject viewer"
            ></button>
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
              const studyProgress = getStudyProgress(node);
              const normalizedStudiedWorks = new Set(
                (node.works || []).map((work) => work.trim().toLocaleLowerCase())
              );
              const recommendationsNeeded = Math.max(0, (node.requiredWorks || 0) - worksStudied);
              const recommendedWorks = (node.recommendedWorks || [])
                .filter((work) => !normalizedStudiedWorks.has(work.trim().toLocaleLowerCase()))
                .slice(0, recommendationsNeeded);
              const complete = isComplete(subject, node);
              return `
                <article
                  class="st-timeline-item is-highlighted${complete ? " is-complete" : ""}"
                  data-timeline-key="${subject.id}:${node.id}"
                  tabindex="0"
                >
                  <div class="st-timeline-card">
                    <div class="st-timeline-card-topline">
                      <span class="st-timeline-year">${node.timelineYearLabel}</span>
                    </div>
                    <h3>${node.title}</h3>
                    <p class="st-timeline-description">${node.description}</p>
                    ${requiresWorks ? `
                      <div class="st-poet-progress">
                        <div><span>${complete ? "Complete" : "Study progress"}</span><strong>${studyProgress.completed} / ${studyProgress.total}</strong></div>
                        <i style="--work-progress: ${Math.min(100, studyProgress.completed / studyProgress.total * 100)}%"></i>
                      </div>
                      <div class="st-studied-works">
                        ${worksStudied ? `
                          <section class="st-work-list is-studied">
                            <p>Studied</p>
                            <ul>${node.works.map((work) => `<li>${work}</li>`).join("")}</ul>
                            ${node.extraWorks?.length ? `
                              <span
                                class="st-extra-works"
                                tabindex="0"
                                title="${node.extraWorks.join(" · ")}"
                                aria-label="${node.extraWorks.length} additional works studied: ${node.extraWorks.join(", ")}"
                              >+${node.extraWorks.length}</span>
                            ` : ""}
                          </section>
                        ` : ""}
                        ${recommendedWorks.length ? `
                          <section class="st-work-list is-recommended">
                            <p>Suggested next</p>
                            <ul>${recommendedWorks.map((work) => `<li>${work}</li>`).join("")}</ul>
                          </section>
                        ` : ""}
                        ${!worksStudied && !recommendedWorks.length
                          ? `<p class="st-no-works">No works recorded yet.</p>`
                          : ""}
                      </div>
                      ${node.requiresAnalysis ? node.analysisDocument ? `
                        <button
                          type="button"
                          class="st-analysis-status st-analysis-toggle is-complete"
                          data-analysis-key="${subject.id}:${node.id}"
                          aria-controls="st-analysis-viewer"
                          aria-expanded="false"
                        >
                          <span>Written analysis</span>
                          <strong>Complete · View PDF</strong>
                        </button>
                      ` : `
                        <p class="st-analysis-status">
                          <span>Written analysis</span>
                          <strong>Pending</strong>
                        </p>
                      ` : ""}
                    ` : `<p class="st-timeline-state">${complete ? "Complete" : "Future"}</p>`}
                  </div>
                </article>
              `;
            }).join("")}
          </div>
        </div>
      </div>
      <section
        class="st-analysis-viewer"
        id="st-analysis-viewer"
        role="region"
        aria-labelledby="st-analysis-viewer-title"
        aria-live="polite"
        hidden
      ></section>
    `;

    const linkedElements = [...timelineWorkspace.querySelectorAll("[data-timeline-key]")];
    const scale = timelineWorkspace.querySelector(".st-timeline-scale");
    const scroller = timelineWorkspace.querySelector(".st-timeline-scroll");
    const analysisViewer = timelineWorkspace.querySelector(".st-analysis-viewer");
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

    let openAnalysisKey = null;
    function closeAnalysisViewer({ restoreFocus = false } = {}) {
      const trigger = openAnalysisKey
        ? timelineWorkspace.querySelector(`.st-analysis-toggle[data-analysis-key="${openAnalysisKey}"]`)
        : null;
      releaseAnalysisDocument();
      analysisViewer.hidden = true;
      analysisViewer.replaceChildren();
      timelineWorkspace.querySelectorAll(".st-analysis-toggle").forEach((button) => {
        button.setAttribute("aria-expanded", "false");
        button.querySelector("strong").textContent = "Complete · View PDF";
      });
      openAnalysisKey = null;
      if (restoreFocus) trigger?.focus({ preventScroll: true });
    }

    timelineWorkspace.querySelectorAll(".st-analysis-toggle").forEach((button) => {
      button.addEventListener("click", () => {
        const analysisKey = button.dataset.analysisKey;
        if (openAnalysisKey === analysisKey && !analysisViewer.hidden) {
          closeAnalysisViewer();
          return;
        }

        const entry = items.find(({ subject, node }) => `${subject.id}:${node.id}` === analysisKey);
        if (!entry?.node.analysisDocument) return;
        closeAnalysisViewer();
        const documentBytes = bytesFromBase64(entry.node.analysisDocument.data);
        activeAnalysisUrl = window.URL.createObjectURL(new Blob(
          [documentBytes],
          { type: entry.node.analysisDocument.type || "application/pdf" }
        ));
        openAnalysisKey = analysisKey;
        button.setAttribute("aria-expanded", "true");
        button.querySelector("strong").textContent = "Complete · Close PDF";
        analysisViewer.innerHTML = `
          <header class="st-analysis-viewer-header">
            <div>
              <p>Written analysis</p>
              <h3 id="st-analysis-viewer-title">${entry.node.title}</h3>
            </div>
            <button type="button" class="st-analysis-viewer-close">Close PDF</button>
          </header>
          <iframe
            class="st-analysis-frame"
            src="${activeAnalysisUrl}"
            title="${entry.node.title} written analysis"
          ></iframe>
        `;
        analysisViewer.hidden = false;
        analysisViewer.querySelector(".st-analysis-viewer-close")?.addEventListener("click", () => {
          closeAnalysisViewer({ restoreFocus: true });
        });
        window.requestAnimationFrame(() => {
          analysisViewer.querySelector(".st-analysis-viewer-close")?.focus({ preventScroll: true });
          analysisViewer.scrollIntoView({
            behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
            block: "start",
          });
        });
      });
    });

    markers.forEach((marker) => {
      marker.addEventListener("focus", () => {
        focusedTimelineKey = marker.dataset.timelineKey;
        updateTimelineLink();
      });
      marker.addEventListener("blur", () => {
        if (focusedTimelineKey === marker.dataset.timelineKey) focusedTimelineKey = null;
        updateTimelineLink();
      });
      marker.addEventListener("click", () => {
        const card = linkedElements.find((element) =>
          element.classList.contains("st-timeline-item") &&
          element.dataset.timelineKey === marker.dataset.timelineKey
        );
        if (!card || !scroller) return;

        const scrollBehavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth";
        card.focus({ preventScroll: true });
        if (window.matchMedia("(max-width: 640px)").matches) {
          card.scrollIntoView({ behavior: scrollBehavior, block: "start", inline: "nearest" });
          return;
        }

        const cardBounds = card.getBoundingClientRect();
        const scrollerBounds = scroller.getBoundingClientRect();
        const centeredLeft = scroller.scrollLeft + cardBounds.left - scrollerBounds.left -
          (scroller.clientWidth - cardBounds.width) / 2;
        scroller.scrollTo({
          left: Math.max(0, centeredLeft),
          behavior: scrollBehavior,
        });
      });
    });

    scale?.addEventListener("pointermove", (event) => {
      const closest = markers.reduce((nearest, marker) => {
        const markerBounds = marker.getBoundingClientRect();
        const distance = Math.hypot(
          markerBounds.left + markerBounds.width / 2 - event.clientX,
          markerBounds.top + markerBounds.height / 2 - event.clientY
        );
        return !nearest || distance < nearest.distance ? { marker, distance } : nearest;
      }, null);
      const closeEnough = closest && closest.distance <= 14;
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
    const recordedChecklistItems = new Set(
      (node.works || []).map((item) => item.trim().toLocaleLowerCase())
    );

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
          ${node.checklistItems?.length ? `
            <ul class="st-node-checklist" aria-label="${node.title} course checklist">
              ${node.checklistItems.map((item) => {
                const checked = recordedChecklistItems.has(item.trim().toLocaleLowerCase());
                return `
                  <li class="${checked ? "is-complete" : ""}">
                    <label>
                      <input type="checkbox" ${checked ? "checked" : ""} disabled>
                      <span>${item}</span>
                    </label>
                  </li>
                `;
              }).join("")}
            </ul>
          ` : `<p>${node.works?.length ? node.works.join(" · ") : "None recorded yet."}</p>`}
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
