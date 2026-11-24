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
