import X from "lucide-react/dist/esm/icons/x";

type SidebarSearchBarProps = {
  isSearchOpen: boolean;
  searchQuery: string;
  searchLabel?: string;
  onSearchQueryChange: (value: string) => void;
  onClearSearch: () => void;
};

export function SidebarSearchBar({
  isSearchOpen,
  searchQuery,
  searchLabel = "Search conversations",
  onSearchQueryChange,
  onClearSearch,
}: SidebarSearchBarProps) {
  return (
    <div className={`sidebar-search${isSearchOpen ? " is-open" : ""}`}>
      {isSearchOpen && (
        <input
          className="sidebar-search-input"
          value={searchQuery}
          onChange={(event) => onSearchQueryChange(event.target.value)}
          placeholder={searchLabel}
          aria-label={searchLabel}
          data-tauri-drag-region="false"
          autoFocus
        />
      )}
      {isSearchOpen && searchQuery.length > 0 && (
        <button
          type="button"
          className="sidebar-search-clear"
          onClick={onClearSearch}
          aria-label="Clear search"
          data-tauri-drag-region="false"
        >
          <X size={12} aria-hidden />
        </button>
      )}
    </div>
  );
}
