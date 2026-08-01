package catalog

import (
	"bufio"
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"

	"github.com/apache/arrow-go/v18/arrow"
	"github.com/apache/iceberg-go/table"
)

// Export formats accepted by ExportRows.
const (
	ExportFormatCSV  = "csv"
	ExportFormatJSON = "json"
)

// ExportRows streams the rows matching filters into w and reports how many it
// wrote. maxRows caps the export; pass 0 for "everything that matches".
//
// The export re-scans rather than serialising whatever the preview happens to
// hold, for two reasons. Values keep their exact Go types — an int64 past 2^53
// would already have been rounded by the time it reached the frontend's row
// buffer — and the export is not limited to the pages the user happened to
// click Load-more on. The cost is that rows come out in scan order: a sort
// applied in the UI orders the loaded page only and is not reflected here.
//
// Nothing is buffered beyond one record batch, so exporting a large table costs
// bounded memory and is bounded in time only by ctx.
func ExportRows(
	ctx context.Context,
	t *table.Table,
	w io.Writer,
	format string,
	filters []PreviewFilterDTO,
	maxRows int,
) (n int, err error) {
	// Same reasoning as BuildPreviewRows: a panic out of iceberg-go's scanner
	// would otherwise take the whole Wails process down.
	defer func() {
		if r := recover(); r != nil {
			n = 0
			err = fmt.Errorf("%w: scan panic: %v", ErrFilter, r)
		}
	}()

	buf := bufio.NewWriter(w)

	var sink rowSink
	switch format {
	case ExportFormatCSV:
		sink = newCSVSink(buf)
	case ExportFormatJSON:
		sink = newJSONSink(buf)
	default:
		return 0, fmt.Errorf("%w: unknown export format %q", ErrFilter, format)
	}

	var (
		written  int
		writeErr error
	)
	// The column order is the scan's, taken before the first row: a row is a
	// map and carries no order of its own, and an exported file that does not
	// line up with the table on screen is a bug the user has to notice by eye.
	prepare := func(schema *arrow.Schema) error {
		names := make([]string, 0, schema.NumFields())
		for i := range schema.NumFields() {
			names = append(names, schema.Field(i).Name)
		}
		return sink.start(names)
	}

	if _, err := streamRows(ctx, t, filters, int64(maxRows), prepare, func(next rowFunc) bool {
		if maxRows > 0 && written >= maxRows {
			return false
		}
		if writeErr = sink.write(next()); writeErr != nil {
			return false
		}
		written++
		return true
	}); err != nil {
		return 0, err
	}
	if writeErr != nil {
		return 0, writeErr
	}

	if err := sink.finish(); err != nil {
		return 0, err
	}
	if err := buf.Flush(); err != nil {
		return 0, err
	}
	return written, nil
}

// rowSink writes rows one at a time, in the column order fixed by start.
type rowSink interface {
	start(columns []string) error
	write(row map[string]any) error
	finish() error
}

// --- CSV ------------------------------------------------------------------

type csvSink struct {
	w       *csv.Writer
	columns []string
}

func newCSVSink(w io.Writer) *csvSink { return &csvSink{w: csv.NewWriter(w)} }

// start writes the header immediately, so an export that matches nothing is
// still a valid CSV rather than an empty file.
func (s *csvSink) start(columns []string) error {
	s.columns = columns
	return s.w.Write(columns)
}

func (s *csvSink) write(row map[string]any) error {
	rec := make([]string, len(s.columns))
	for i, c := range s.columns {
		rec[i] = csvCell(row[c])
	}
	return s.w.Write(rec)
}

func (s *csvSink) finish() error {
	s.w.Flush()
	return s.w.Error()
}

// csvCell renders one value. CSV has no null, so a null cell is written as an
// empty field — indistinguishable from an empty string, which is the format's
// limitation and part of why JSON is offered alongside it.
func csvCell(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	case bool:
		if x {
			return "true"
		}
		return "false"
	case map[string]any, []any:
		// Structs, lists and maps go out as compact JSON rather than Go's
		// map-printing syntax, so the column stays machine-readable.
		b, err := json.Marshal(x)
		if err != nil {
			return fmt.Sprint(x)
		}
		return string(b)
	default:
		return fmt.Sprint(x)
	}
}

// --- JSON -----------------------------------------------------------------

// jsonSink writes a JSON array incrementally: one object per row, written as
// the row arrives rather than accumulated. Keys are emitted in scan order,
// which encoding/json would not do for a map — it sorts them.
type jsonSink struct {
	w       io.Writer
	columns []string
	n       int
	err     error
}

func newJSONSink(w io.Writer) *jsonSink { return &jsonSink{w: w} }

func (s *jsonSink) start(columns []string) error {
	s.columns = columns
	return nil
}

func (s *jsonSink) write(row map[string]any) error {
	if s.err != nil {
		return s.err
	}
	if s.n == 0 {
		s.print("[\n")
	} else {
		s.print(",\n")
	}
	s.print("  {")
	for i, c := range s.columns {
		if i > 0 {
			s.print(", ")
		}
		key, err := json.Marshal(c)
		if err != nil {
			return err
		}
		val, err := json.Marshal(row[c])
		if err != nil {
			return fmt.Errorf("column %q: %w", c, err)
		}
		s.print(string(key))
		s.print(": ")
		s.print(string(val))
	}
	s.print("}")
	s.n++
	return s.err
}

func (s *jsonSink) finish() error {
	if s.err != nil {
		return s.err
	}
	if s.n == 0 {
		s.print("[]\n")
		return s.err
	}
	s.print("\n]\n")
	return s.err
}

func (s *jsonSink) print(str string) {
	if s.err != nil {
		return
	}
	_, s.err = io.WriteString(s.w, str)
}
