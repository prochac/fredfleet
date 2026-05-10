package catalog

// NamespaceDTO is a single namespace row returned by ListNamespaces. Path is
// the full path (e.g. ["analytics","raw"]); Name is the last segment used for
// display.
type NamespaceDTO struct {
	Path []string `json:"path"`
	Name string   `json:"name"`
}

// TableDTO is a single table row returned by ListTables.
type TableDTO struct {
	Namespace []string `json:"namespace"`
	Name      string   `json:"name"`
}

// FieldKind classifies a schema field for the recursive renderer on the
// frontend. The frontend uses Kind to decide whether to show a disclosure
// triangle and recurse into Children.
const (
	FieldKindPrimitive = "primitive"
	FieldKindStruct    = "struct"
	FieldKindList      = "list"
	FieldKindMap       = "map"
)

// FieldDTO is one node of the schema tree. For lists and maps, synthetic
// children with names "element" / "key" / "value" are emitted so the frontend
// recurses uniformly.
type FieldDTO struct {
	ID       int        `json:"id"`
	Name     string     `json:"name"`
	Required bool       `json:"required"`
	Doc      string     `json:"doc,omitempty"`
	Kind     string     `json:"kind"`
	TypeText string     `json:"typeText"`
	Children []FieldDTO `json:"children,omitempty"`
}

type SchemaDTO struct {
	ID                 int        `json:"id"`
	IdentifierFieldIDs []int      `json:"identifierFieldIds,omitempty"`
	Fields             []FieldDTO `json:"fields"`
}

type PartitionFieldDTO struct {
	SourceID  int    `json:"sourceId"`
	FieldID   int    `json:"fieldId"`
	Name      string `json:"name"`
	Transform string `json:"transform"`
}

type PartitionSpecDTO struct {
	SpecID int                 `json:"specId"`
	Fields []PartitionFieldDTO `json:"fields"`
}

type PropertyDTO struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

type TableMetadataDTO struct {
	Namespace         []string         `json:"namespace"`
	Name              string           `json:"name"`
	FormatVersion     int              `json:"formatVersion"`
	Location          string           `json:"location"`
	CurrentSnapshotID *int64           `json:"currentSnapshotId,omitempty"`
	Schema            SchemaDTO        `json:"schema"`
	PartitionSpec     PartitionSpecDTO `json:"partitionSpec"`
	Properties        []PropertyDTO    `json:"properties"`
}
