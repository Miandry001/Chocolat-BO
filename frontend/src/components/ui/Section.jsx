import { useId } from "react";

export function Section({ title, sticky = false, children }) {
  const titleId = useId();
  return (
    <section className={sticky ? "sticky" : undefined} aria-labelledby={titleId}>
      <h2 id={titleId} className="section-title">{title}</h2>
      {children}
    </section>
  );
}
