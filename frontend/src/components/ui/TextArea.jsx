export function TextArea({ className = "", ...props }) {
  return <textarea className={`control ${className}`.trim()} {...props} />;
}
