package catalog

import (
	"sort"

	"github.com/apache/iceberg-go"
	"github.com/apache/iceberg-go/table"
)

func schemaToDTO(s *iceberg.Schema) SchemaDTO {
	if s == nil {
		return SchemaDTO{Fields: []FieldDTO{}}
	}
	fields := s.Fields()
	out := SchemaDTO{
		ID:                 s.ID,
		IdentifierFieldIDs: append([]int(nil), s.IdentifierFieldIDs...),
		Fields:             make([]FieldDTO, 0, len(fields)),
	}
	for _, f := range fields {
		out.Fields = append(out.Fields, nestedFieldToDTO(f))
	}
	return out
}

func nestedFieldToDTO(f iceberg.NestedField) FieldDTO {
	return typeToField(f.ID, f.Name, f.Required, f.Doc, f.Type)
}

// typeToField converts an iceberg.Type into a FieldDTO. For struct/list/map
// it recurses; lists and maps emit synthetic "element" / "key" / "value"
// children so the frontend can render every level uniformly.
func typeToField(id int, name string, required bool, doc string, t iceberg.Type) FieldDTO {
	dto := FieldDTO{
		ID:       id,
		Name:     name,
		Required: required,
		Doc:      doc,
		TypeText: typeText(t),
	}
	switch tt := t.(type) {
	case *iceberg.StructType:
		dto.Kind = FieldKindStruct
		dto.Children = make([]FieldDTO, 0, len(tt.FieldList))
		for _, child := range tt.FieldList {
			dto.Children = append(dto.Children, nestedFieldToDTO(child))
		}
	case *iceberg.ListType:
		dto.Kind = FieldKindList
		elem := tt.ElementField()
		dto.Children = []FieldDTO{nestedFieldToDTO(elem)}
	case *iceberg.MapType:
		dto.Kind = FieldKindMap
		dto.Children = []FieldDTO{
			nestedFieldToDTO(tt.KeyField()),
			nestedFieldToDTO(tt.ValueField()),
		}
	default:
		dto.Kind = FieldKindPrimitive
	}
	return dto
}

func typeText(t iceberg.Type) string {
	if t == nil {
		return ""
	}
	return t.String()
}

func specToDTO(s iceberg.PartitionSpec) PartitionSpecDTO {
	out := PartitionSpecDTO{
		SpecID: s.ID(),
		Fields: []PartitionFieldDTO{},
	}
	for f := range s.Fields() {
		transform := ""
		if f.Transform != nil {
			transform = f.Transform.String()
		}
		out.Fields = append(out.Fields, PartitionFieldDTO{
			SourceID:  f.SourceID,
			FieldID:   f.FieldID,
			Name:      f.Name,
			Transform: transform,
		})
	}
	return out
}

func propertiesToDTO(p iceberg.Properties) []PropertyDTO {
	out := make([]PropertyDTO, 0, len(p))
	for k, v := range p {
		out = append(out, PropertyDTO{Key: k, Value: v})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Key < out[j].Key })
	return out
}

// BuildTableMetadataDTO converts a loaded iceberg table into the wire-format
// DTO sent to the frontend. The namespace and name arguments are passed
// through verbatim — the table itself doesn't carry its own identifier in a
// shape we can rely on.
func BuildTableMetadataDTO(namespace []string, name string, t *table.Table) TableMetadataDTO {
	md := t.Metadata()
	dto := TableMetadataDTO{
		Namespace:     append([]string(nil), namespace...),
		Name:          name,
		FormatVersion: md.Version(),
		Location:      t.Location(),
		Schema:        schemaToDTO(t.Schema()),
		PartitionSpec: specToDTO(t.Spec()),
		Properties:    propertiesToDTO(t.Properties()),
	}
	if snap := t.CurrentSnapshot(); snap != nil {
		id := snap.SnapshotID
		dto.CurrentSnapshotID = &id
	}
	return dto
}
