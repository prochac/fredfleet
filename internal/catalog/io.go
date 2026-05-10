package catalog

// Side-effect import: registers iceberg-go IO factories for s3, s3a, s3n, gs,
// abfs, abfss, wasb, wasbs, and mem. Without this, table.Scan fails on any
// non-local data file with "io scheme not registered". Vended credentials
// (Lakekeeper, Polaris) are read from table properties by the factory.
import _ "github.com/apache/iceberg-go/io/gocloud"
