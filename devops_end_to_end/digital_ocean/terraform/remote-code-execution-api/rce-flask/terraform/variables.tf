variable "ssh_key_name" {
  description = "Name of the SSH key that already exists in your DigitalOcean account"
  type        = string
  default     = "digital_ocean_key"
}

variable "repo_url" {
  description = "Git URL the droplet clones, e.g. https://github.com/you/express-api.git"
  type        = string
}

variable "database_url" {
  description = "postgresql://user:pass@host:5432/db?sslmode=require"
  type        = string
  sensitive   = true
}

variable "fqdn" {
  description = "Public hostname for the API, e.g. api.example.com"
  type        = string
}

variable "dns_zone" {
  description = "Domain managed in DigitalOcean DNS (e.g. example.com). Leave empty to manage DNS yourself."
  type        = string
  default     = ""
}

variable "region" {
  type    = string
  default = "blr1" # Bangalore. Others: nyc3, sfo3, fra1, sgp1, ...
}

variable "size" {
  type    = string
  default = "s-1vcpu-2gb" # 2 GB RAM so npm install + tsc don't run out of memory
}

variable "ssh_allowed_cidrs" {
  description = "Who may SSH in. Restrict to your own IP, e.g. [\"203.0.113.7/32\"]"
  type        = list(string)
  default     = ["0.0.0.0/0", "::/0"]
}
