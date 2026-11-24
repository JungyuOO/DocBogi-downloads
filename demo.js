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
