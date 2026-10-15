import React, { useMemo } from "react";
import LABEL_REFERENCES from "../../data/labelReferences";
import { calculateLabelInformation } from "./labelRules";

export default function LabelMultiSelect({ value = [], onChange }) {
  const labels = useMemo(() => LABEL_REFERENCES.map(x => x.label), []);
  const info = useMemo(() => calculateLabelInformation(value), [value]);

  const toggle = (label) => {
    const next = value.includes(label)
      ? value.filter(x => x !== label)
      : [...value, label];
    onChange?.(next);
  };

  return (
    <div className="label-field">
      <div className="label-options">
        {labels.map(label => (
          <label key={label} className="label-option">
            <input type="checkbox" checked={value.includes(label)} onChange={() => toggle(label)} />
            <span>{label}</span>
          </label>
        ))}
      </div>

      <div className="label-derived-fields">
        <input readOnly value={info.infoBiologique} placeholder="INFO BIOLOGIQUE" />
        <input readOnly value={info.infoEquitable} placeholder="INFO COMMERCE EQUITABLE" />
        <input readOnly value={info.infoEcologique} placeholder="INFO ECOLOGIQUE" />
        <input readOnly value={info.infoVegetal} placeholder="INFO VEGETAL" />
      </div>
    </div>
  );
}
