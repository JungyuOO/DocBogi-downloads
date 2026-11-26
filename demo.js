"use strict";

// Adapted from the layered planes in ThreeUI Community's DiagnosticsPanel.
// Copyright (c) 2026 Meng To. MIT licensed, see vendor/threeui/LICENSE.
function bindDiagnosticsLayers(scene, canMove) {
  const layers = [...scene.querySelectorAll("[data-sample-plane]")];
  const angle = Math.PI / 6;
  let motionFrame = 0;

  function projectIso(x, y, z) {
    return { x: (x - z) * Math.cos(angle), y: y + (x + z) * Math.sin(angle) };
  }

  function resetLayers() {
    window.cancelAnimationFrame(motionFrame);
    motionFrame = 0;
    for (const layer of layers) {
      layer.style.removeProperty("--plane-x");
      layer.style.removeProperty("--plane-y");
    }
  }

  scene.addEventListener("pointermove", event => {
    if (!canMove() || event.pointerType !== "mouse" || event.buttons) return;
    window.cancelAnimationFrame(motionFrame);
    motionFrame = window.requestAnimationFrame(() => {
      motionFrame = 0;
      const bounds = scene.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      const x = (event.clientX - bounds.left) / bounds.width - .5;
      const z = (event.clientY - bounds.top) / bounds.height - .5;

      for (const layer of layers) {
        const depth = Number(layer.dataset.samplePlane);
        const offset = projectIso(x * depth, 0, z * depth);
        layer.style.setProperty("--plane-x", offset.x.toFixed(2) + "px");
        layer.style.setProperty("--plane-y", offset.y.toFixed(2) + "px");
      }
    });
  }, { passive: true });

  scene.addEventListener("pointerleave", resetLayers);
  return resetLayers;
}

const sample = document.querySelector("[data-sample]");

if (sample) {
  const surface = sample.querySelector("[data-sample-surface]");
  const dropZone = sample.querySelector("[data-sample-drop]");
  const scene = sample.querySelector("[data-sample-scene]");
  const paper = sample.querySelector("[data-sample-file]");
  const intro = sample.querySelector("[data-sample-intro]");
  const nextLinks = sample.querySelector("[data-sample-next]");
  const instruction = sample.querySelector("[data-sample-instructions]");
  const classify = sample.querySelector("[data-sample-classify]");
  const reset = sample.querySelector("[data-sample-reset]");
  const status = sample.querySelector("[data-sample-status]");
  const panels = [...sample.querySelectorAll("[data-sample-panel]")];
  const dragLayout = window.matchMedia("(any-hover: hover) and (any-pointer: fine)");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const sampleDragType = "application/x-docbogi-sample";
  let draggingPaper = false;
  let filingTimer;
  const resetLayers = bindDiagnosticsLayers(scene, () =>
    dragLayout.matches && !reducedMotion.matches && !draggingPaper && sample.dataset.state === "ready"
  );

  function syncDragSupport() {
    paper.draggable = dragLayout.matches;
    if (!dragLayout.matches) resetLayers();
    instruction.textContent = dragLayout.matches
      ? "문서를 보관함에 끌어다 놓거나 버튼을 눌러 보세요."
      : "버튼으로 샘플 문서를 분류해 보세요.";
  }

  function clearDrag() {
    draggingPaper = false;
    sample.removeAttribute("data-drag-over");
  }

  function showPanel(name) {
    const next = panels.find(panel => panel.dataset.samplePanel === name);
    if (!next) return;
    window.clearTimeout(filingTimer);
    resetLayers();
    sample.dataset.state = name;
    surface.removeAttribute("aria-busy");
    scene.hidden = true;
    intro.hidden = true;
    nextLinks.hidden = false;
    reset.hidden = false;
    status.textContent = "";
    for (const panel of panels) panel.hidden = panel !== next;
    next.querySelector("h3").focus({ preventScroll: true });
  }

  function fileSample(animate) {
    if (sample.dataset.state !== "ready") return;
    clearDrag();

    if (!animate || reducedMotion.matches) {
      showPanel("summary");
      return;
    }

    sample.dataset.state = "filing";
    resetLayers();
    surface.setAttribute("aria-busy", "true");
    classify.disabled = true;
    status.textContent = "샘플 문서를 분류하는 중입니다.";
    filingTimer = window.setTimeout(() => showPanel("summary"), 480);
  }

  classify.addEventListener("click", event => {
    fileSample(event.detail > 0 && dragLayout.matches);
  });

  for (const button of sample.querySelectorAll("[data-sample-view]")) {
    button.addEventListener("click", () => showPanel(button.dataset.sampleView));
  }

  reset.addEventListener("click", () => {
    window.clearTimeout(filingTimer);
    clearDrag();
    sample.dataset.state = "ready";
    surface.removeAttribute("aria-busy");
    for (const panel of panels) panel.hidden = true;
    reset.hidden = true;
    scene.hidden = false;
    intro.hidden = false;
    nextLinks.hidden = true;
    classify.disabled = false;
    status.textContent = "샘플 문서를 다시 분류할 수 있습니다.";
    classify.focus({ preventScroll: true });
  });

  paper.addEventListener("dragstart", event => {
    if (!dragLayout.matches || sample.dataset.state !== "ready" || !event.dataTransfer) {
      event.preventDefault();
      return;
    }
    draggingPaper = true;
    resetLayers();
    event.dataTransfer.setData(sampleDragType, "onboarding-workshop");
    event.dataTransfer.effectAllowed = "move";
  });
  paper.addEventListener("dragend", clearDrag);

  surface.addEventListener("dragover", event => {
    const transfer = event.dataTransfer;
    if (!transfer) return;
    if (draggingPaper && dropZone.contains(event.target)) {
      event.preventDefault();
      transfer.dropEffect = "move";
      sample.setAttribute("data-drag-over", "");
    } else if (transfer.types.includes("Files")) {
      event.preventDefault();
      transfer.dropEffect = "none";
    }
  });

  surface.addEventListener("dragleave", event => {
    if (!event.relatedTarget || !dropZone.contains(event.relatedTarget)) {
      sample.removeAttribute("data-drag-over");
    }
  });

  surface.addEventListener("drop", event => {
    const transfer = event.dataTransfer;
    if (!transfer) return;
    if (draggingPaper && dropZone.contains(event.target) && transfer.getData(sampleDragType) === "onboarding-workshop") {
      event.preventDefault();
      fileSample(true);
    } else if (transfer.types.includes("Files")) {
      event.preventDefault();
      status.textContent = "체험에서는 준비된 샘플 문서만 사용할 수 있습니다.";
    }
    clearDrag();
  });

  reducedMotion.addEventListener("change", () => {
    if (reducedMotion.matches) resetLayers();
    if (reducedMotion.matches && sample.dataset.state === "filing") showPanel("summary");
  });
  dragLayout.addEventListener("change", syncDragSupport);
  syncDragSupport();
  intro.hidden = false;
}


const story = document.querySelector("[data-story]");
const livePreview = story?.querySelector("[data-story-live]");
const stages = [...(story?.querySelectorAll("[data-stage]") ?? [])];
const links = [...(story?.querySelectorAll(".story-nav a") ?? [])];
const pinnedLayout = window.matchMedia("(min-width: 980px) and (min-height: 640px) and (prefers-reduced-motion: no-preference)");

if (story && livePreview && stages.length && links.length === stages.length) {
  let activeIndex = -1;
  let pendingFrame = 0;

  function activate(index) {
    if (index === activeIndex) return;
    const material = stages[index].querySelector("[data-story-content]");
    if (!material) return;
    const preview = material.cloneNode(true);
    const image = preview.querySelector("img");
    if (image) image.loading = "eager";
    livePreview.replaceChildren(preview);
    story.dataset.activeStage = stages[index].dataset.stage;
    links.forEach((link, i) => {
      if (i === index) link.setAttribute("aria-current", "step");
      else link.removeAttribute("aria-current");
    });
    activeIndex = index;
  }

  function updateFromScroll() {
    pendingFrame = 0;
    if (!pinnedLayout.matches) return;
    const header = document.querySelector(".site-header")?.getBoundingClientRect().bottom ?? 0;
    const readingLine = header + (window.innerHeight - header) * 0.34;
    let index = 0;
    for (let i = 1; i < stages.length; i++) {
      if (stages[i].getBoundingClientRect().top > readingLine) break;
      index = i;
    }
    activate(index);
  }

  function requestUpdate() {
    if (pinnedLayout.matches && !pendingFrame) pendingFrame = window.requestAnimationFrame(updateFromScroll);
  }

  function updateLayout() {
    story.classList.toggle("is-pinned", pinnedLayout.matches);
    livePreview.hidden = !pinnedLayout.matches;
    if (pinnedLayout.matches) {
      if (activeIndex === -1) activate(0);
      requestUpdate();
    } else {
      story.dataset.activeStage = "find";
      links.forEach(link => link.removeAttribute("aria-current"));
      activeIndex = -1;
    }
  }

  window.addEventListener("scroll", requestUpdate, { passive: true });
  window.addEventListener("resize", requestUpdate);
  window.addEventListener("hashchange", requestUpdate);
  window.addEventListener("pageshow", requestUpdate);
  pinnedLayout.addEventListener("change", updateLayout);
  updateLayout();
}

const theater = document.querySelector("[data-theater]");
const reelLinks = [...(theater?.querySelectorAll("[data-reel-link]") ?? [])];
const reels = [...(theater?.querySelectorAll("[data-reel]") ?? [])];

if (theater && reels.length && reelLinks.length === reels.length) {
  let selected;
  function selectReel(id) {
    const next = reels.find(reel => reel.id === id);
    if (!next || next === selected) return;
    const restoreFocus = selected?.contains(document.activeElement);
    for (const reel of reels) {
      if (reel !== next) reel.querySelector("video")?.pause();
      reel.hidden = reel !== next;
    }
    for (const link of reelLinks) {
      if (link.hash === "#" + id) {
        link.setAttribute("aria-current", "true");
        if (restoreFocus) link.focus({ preventScroll: true });
      } else link.removeAttribute("aria-current");
    }
    selected = next;
  }

  function syncReelFromHash() {
    const hash = window.location.hash;
    if (!hash || hash === "#demo") selectReel(reels[0].id);
    else if (reels.some(reel => hash === "#" + reel.id)) selectReel(hash.slice(1));
  }

  for (const link of reelLinks) {
    link.addEventListener("click", event => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      // The destination must be visible before native fragment navigation starts.
      selectReel(link.hash.slice(1));
    });
  }
  window.addEventListener("hashchange", syncReelFromHash);
  window.addEventListener("pageshow", syncReelFromHash);
  syncReelFromHash();
  if (!selected) selectReel(reels[0].id);
}
