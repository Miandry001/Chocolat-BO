export function Field({ id, label, wide = false, required = false, error, children }) {
  return (
    <div className={wide ? "field field--wide" : "field"}>
      <label htmlFor={id}>
        {label}
        {required && <span className="field-required" aria-hidden="true"> *</span>}
      </label>
      {children}
      {error && (
        <p id={`${id}-error`} className="field-error">
          {error}
        </p>
      )}
    </div>
  );
}
