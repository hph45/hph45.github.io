const revealItems = document.querySelectorAll(".reveal");

const observer = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add("is-visible");
      } else if (!entry.target.classList.contains("hero")) {
        entry.target.classList.remove("is-visible");
      }
    });
  },
  {
    threshold: 0.3,
    rootMargin: "0px 0px -12% 0px",
  }
);

revealItems.forEach((item) => observer.observe(item));
