'use client';

export default function CheckboxChips({ options, value = [], onChange, columns = false }) {
  const selected = Array.isArray(value) ? value : [];
  const visibleOptions = [
    ...options,
    ...selected.filter((item) => item && !options.includes(item)),
  ];

  function toggle(option) {
    if (selected.includes(option)) {
      onChange(selected.filter((item) => item !== option));
      return;
    }

    onChange([...selected, option]);
  }

  return (
    <div className={columns ? 'grid grid-cols-2 gap-2' : 'flex flex-wrap gap-2'}>
      {visibleOptions.map((option) => {
        const checked = selected.includes(option);

        return (
          <button
            key={option}
            type="button"
            onClick={() => toggle(option)}
            className={`rounded-full border px-3 py-1.5 text-sm transition-colors ${
              checked
                ? 'border-primary-500 bg-primary-50 text-primary-700'
                : 'border-gray-300 bg-white text-gray-700 hover:border-gray-400'
            }`}
            aria-pressed={checked}
          >
            {option}
          </button>
        );
      })}
    </div>
  );
}
