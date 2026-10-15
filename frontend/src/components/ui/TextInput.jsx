export function TextInput({ className = "", ...props }) {
  return <input className={`control ${className}`.trim()} {...props} />;
}
