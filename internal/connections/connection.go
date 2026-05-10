package connections

const (
	TypeREST = "rest"

	AuthBearer = "bearer"
	AuthOAuth2 = "oauth2_client_credentials"
)

type Connection struct {
	Name      string `json:"name"`
	Type      string `json:"type"`
	URL       string `json:"url"`
	Warehouse string `json:"warehouse,omitempty"`
	Auth      Auth   `json:"auth"`
	S3        *S3    `json:"s3,omitempty"`
}

type Auth struct {
	Kind     string `json:"kind"`
	AuthURL  string `json:"authUrl,omitempty"`
	ClientID string `json:"clientId,omitempty"`
	Scope    string `json:"scope,omitempty"`
}

// S3 holds optional, explicit storage credentials passed through to iceberg-go
// via rest.WithAdditionalProps. Only needed when the catalog does not vend
// credentials (e.g. Lakekeeper warehouses without a storage profile, or local
// MinIO setups). The secret access key is never stored here — it lives in the
// OS keyring under "<name>:s3".
type S3 struct {
	AccessKeyID string `json:"accessKeyId,omitempty"`
	Region      string `json:"region,omitempty"`
	Endpoint    string `json:"endpoint,omitempty"`
}
