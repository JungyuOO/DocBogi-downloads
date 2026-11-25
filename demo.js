"use strict";

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
