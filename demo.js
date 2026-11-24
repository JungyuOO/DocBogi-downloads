"use strict";

const demo = document.querySelector(".demo video");
const motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");

if (demo) {
  demo.muted = true;
  if (!motionPreference.matches) {
    demo.play().catch(() => {
      // The native playback controls remain available when autoplay is blocked.
    });
  }
  motionPreference.addEventListener("change", event => {
    if (event.matches) demo.pause();
  });
}

const preview = document.querySelector("[data-document-preview]");
const playback = document.querySelector("[data-preview-playback]");
const previewStatus = document.querySelector("[data-preview-status]");

if (preview && playback && previewStatus) {
  const files = [...preview.querySelectorAll("button[aria-controls]")];
  const summaries = files.map(file => document.getElementById(file.getAttribute("aria-controls")));
  let selected = 0;
  let nextPreview;
  let filingEffect;
  let pointerInside = false;
  let focusInside = preview.contains(document.activeElement);
  let userPaused = motionPreference.matches;
  let visible = true;

  function selectDocument(index, automatic = false) {
    window.clearTimeout(filingEffect);
    delete preview.dataset.phase;

    if (index !== selected) {
      files[selected].setAttribute("aria-pressed", "false");
      summaries[selected].hidden = true;
      selected = index;
      files[selected].setAttribute("aria-pressed", "true");
      summaries[selected].hidden = false;
    }

    if (automatic && !motionPreference.matches) {
      preview.dataset.phase = "filing";
      filingEffect = window.setTimeout(() => {
        delete preview.dataset.phase;
      }, 640);
    } else if (!automatic) {
      const summary = summaries[selected];
      previewStatus.textContent = [...summary.children].map(element => element.textContent).join(" · ");
    }
  }

  function refreshPlayback() {
    window.clearTimeout(nextPreview);
    playback.textContent = userPaused ? "자동 시연 재생" : "자동 시연 일시정지";
    if (userPaused || pointerInside || focusInside || !visible || document.hidden) return;

    nextPreview = window.setTimeout(() => {
      selectDocument((selected + 1) % files.length, true);
      refreshPlayback();
    }, 3150);
  }

  preview.addEventListener("pointerenter", event => {
    if (event.pointerType === "touch") return;
    pointerInside = true;
    refreshPlayback();
  });
  preview.addEventListener("pointerleave", event => {
    if (event.pointerType === "touch") return;
    pointerInside = false;
    refreshPlayback();
  });
  preview.addEventListener("focusin", () => {
    focusInside = true;
    refreshPlayback();
  });
  preview.addEventListener("focusout", event => {
    focusInside = preview.contains(event.relatedTarget);
    refreshPlayback();
  });

  files.forEach((file, index) => {
    let touchActivation = false;
    file.addEventListener("pointerenter", event => {
      if (event.pointerType !== "touch") selectDocument(index);
    });
    file.addEventListener("focus", () => selectDocument(index));
    file.addEventListener("pointerdown", event => {
      touchActivation = event.pointerType === "touch";
    });
    file.addEventListener("pointercancel", () => {
      touchActivation = false;
    });
    file.addEventListener("click", event => {
      // A tap keeps the preview available even in browsers where it does not set focus.
      if (event.detail > 0 && (event.pointerType === "touch" || touchActivation)) userPaused = true;
      touchActivation = false;
      selectDocument(index);
      refreshPlayback();
    });
  });

  playback.addEventListener("click", () => {
    userPaused = !userPaused;
    refreshPlayback();
  });
  motionPreference.addEventListener("change", event => {
    if (event.matches) userPaused = true;
    refreshPlayback();
  });
  document.addEventListener("visibilitychange", refreshPlayback);
  if ("IntersectionObserver" in window) {
    new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      refreshPlayback();
    }).observe(preview);
  }

  playback.hidden = false;
  if (!userPaused && !document.hidden) selectDocument(0, true);
  refreshPlayback();
}

for (const details of document.querySelectorAll(".faq-list details")) {
  const summary = details.querySelector("summary");
  const answer = details.querySelector(".faq-answer");
  if (!summary || !answer || typeof details.animate !== "function") continue;

  let animation;
  let targetOpen = details.open;

  function finishMotion(activeAnimation) {
    if (animation !== activeAnimation) return;
    details.open = targetOpen;
    animation = undefined;
    activeAnimation.cancel();
    delete details.dataset.faqMotion;
  }

  summary.addEventListener("click", event => {
    if (event.defaultPrevented || motionPreference.matches) return;
    event.preventDefault();

    const nextOpen = animation ? !targetOpen : !details.open;
    const startHeight = details.getBoundingClientRect().height;
    animation?.cancel();
    animation = undefined;
    targetOpen = nextOpen;

    // Keep the answer available for measurement and for the closing transition.
    details.open = true;
    const openHeight = details.getBoundingClientRect().height;
    const endHeight = nextOpen ? openHeight : openHeight - answer.getBoundingClientRect().height;
    if (Math.abs(startHeight - endHeight) < 1) {
      details.open = nextOpen;
      delete details.dataset.faqMotion;
      return;
    }

    details.dataset.faqMotion = nextOpen ? "opening" : "closing";
    const activeAnimation = details.animate(
      [{ height: `${startHeight}px` }, { height: `${endHeight}px` }],
      { duration: 220, easing: "ease", fill: "both" }
    );
    animation = activeAnimation;
    activeAnimation.onfinish = () => finishMotion(activeAnimation);
  });

  motionPreference.addEventListener("change", event => {
    if (event.matches && animation) finishMotion(animation);
  });
}
