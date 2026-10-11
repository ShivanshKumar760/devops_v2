# ONE Global Load Balancer in front of the 3 regional load balancers.
# Run AFTER Step 6 (the regional LBs must already exist).
terraform {
  required_providers {
    digitalocean = {
      source  = "digitalocean/digitalocean"
      version = "~> 2.0"
    }
  }
}

provider "digitalocean" {}

variable "domain" {
  description = "Public hostname, e.g. leetcode.example.com"
  type        = string
}

variable "dns_on_digitalocean" {
  description = "true if the domain's DNS zone is in DigitalOcean"
  type        = bool
  default     = false
}

data "digitalocean_loadbalancer" "regional" {
  for_each = toset(["blr1", "nyc3", "sgp1"])
  name     = "leetcode-${each.key}"
}

resource "digitalocean_loadbalancer" "global" {
  name   = "leetcode-global"
  type   = "GLOBAL"
  region = "nyc3"

  forwarding_rule {
    entry_port      = 80
    entry_protocol  = "http"
    target_port     = 80
    target_protocol = "http"
  }

  healthcheck {
    port     = 80
    protocol = "http"
    path     = "/health"
  }

  glb_settings {
    target_protocol = "http"
    target_port     = 80
    cdn {
      is_enabled = false
    }
    # Optional: prefer regions in a fixed order instead of "nearest":
    # region_priorities  = { blr1 = 1, sgp1 = 2, nyc3 = 3 }
    # failover_threshold = 50
  }

  domains {
    name       = var.domain
    is_managed = var.dns_on_digitalocean
  }

  target_load_balancer_ids = [for lb in data.digitalocean_loadbalancer.regional : lb.id]
}

output "global_lb_id" { value = digitalocean_loadbalancer.global.id }
output "global_lb_ip" { value = digitalocean_loadbalancer.global.ip }
