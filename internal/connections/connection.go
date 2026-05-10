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
}

type Auth struct {
	Kind     string `json:"kind"`
	AuthURL  string `json:"authUrl,omitempty"`
	ClientID string `json:"clientId,omitempty"`
	Scope    string `json:"scope,omitempty"`
}
