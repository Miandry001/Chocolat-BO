import { useEffect, useId, useRef, useState } from "react";
import { TextInput } from "./TextInput.jsx";

const EMPTY_SUGGESTIONS = [];

function activePrefix(value) {
  const start = Math.max(value.lastIndexOf(" "), value.lastIndexOf("/"), value.lastIndexOf("&")) + 1;
  return value.slice(start).trimStart();
}

export function SuggestionInput({ fieldName, value, onChange, onBlur, onFocus, onKeyDown, staticSuggestions = EMPTY_SUGGESTIONS, ...props }) {
  const listId = useId();
  const listRef = useRef(null);
  const [focused, setFocused] = useState(false);
  const [typing, setTyping] = useState(false);
  const [suggestions, setSuggestions] = useState([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const prefix = activePrefix(value || "");
  const open = focused && typing && prefix.length >= 2 && suggestions.length > 0;

  useEffect(() => {
    if (!focused || !typing || prefix.length < 2) {
      setSuggestions([]);
      setActiveIndex(-1);
      return undefined;
    }

    const controller = new AbortController();
    const timeout = setTimeout(async () => {
      setSuggestions([]);
      setActiveIndex(-1);
      const local = staticSuggestions.filter((word) =>
        String(word).toLocaleLowerCase().includes(prefix.toLocaleLowerCase()),
      );
      try {
        const params = new URLSearchParams({ field: fieldName, q: prefix });
        const response = await fetch(`/api/v1/suggestions?${params}`, { signal: controller.signal, credentials: "same-origin" });
        if (response.ok) {
          const body = await response.json();
          const remote = (body.data || []).map((entry) => entry.word);
          setSuggestions([...new Set([...local, ...remote])].slice(0, 10));
          return;
        }
      } catch (error) {
        if (error.name === "AbortError") return;
      }
      setSuggestions([...new Set(local)].slice(0, 10));
    }, 80);

    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [fieldName, focused, prefix, staticSuggestions, typing]);

  useEffect(() => {
    if (activeIndex < 0) return;
    listRef.current?.querySelector(`[data-suggestion-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const choose = (word) => {
    const current = value || "";
    const start = Math.max(current.lastIndexOf(" "), current.lastIndexOf("/"), current.lastIndexOf("&")) + 1;
    onChange(`${current.slice(0, start)}${word} `);
    setSuggestions([]);
    setActiveIndex(-1);
    setTyping(false);
  };

  const handleKeyDown = (event) => {
    if (open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((current) => {
        if (current < 0) return direction === 1 ? 0 : suggestions.length - 1;
        return (current + direction + suggestions.length) % suggestions.length;
      });
    } else if (open && (event.key === " " || event.key === "Enter")) {
      event.preventDefault();
      choose(suggestions[activeIndex < 0 ? 0 : activeIndex]);
    } else if (event.key === "Escape") {
      setSuggestions([]);
      setActiveIndex(-1);
    }
    onKeyDown?.(event);
  };

  return (
    <span className="suggestion-input">
      <TextInput
        {...props}
        value={value}
        autoComplete="off"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
        onChange={(event) => {
          setTyping(true);
          onChange(event.target.value);
        }}
        onKeyDown={handleKeyDown}
        onFocus={(event) => {
          setFocused(true);
          onFocus?.(event);
        }}
        onBlur={(event) => {
          setFocused(false);
          setTyping(false);
          onBlur?.(event);
        }}
      />
      {open && (
        <div className="suggestion-list" id={listId} role="listbox" ref={listRef}>
          {suggestions.map((word, index) => (
            <button
              className={index === activeIndex ? "suggestion-option suggestion-option--active" : "suggestion-option"}
              data-suggestion-index={index}
              id={`${listId}-${index}`}
              key={word}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => choose(word)}
            >
              {word}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
