# Creates the 3 DOKS clusters: India (Bangalore), America (New York), Singapore.
terraform {
  required_providers {
    digitalocean = {
      source  = "digitalocean/digitalocean"
      version = "~> 2.0"
    }
  }
}

provider "digitalocean" {} # reads your token from the DIGITALOCEAN_TOKEN environment variable

locals {
  regions = ["blr1", "nyc3", "sgp1"] # India, America, Singapore
}

data "digitalocean_kubernetes_versions" "current" {}

resource "digitalocean_kubernetes_cluster" "leetcode" {
  for_each      = toset(local.regions)
  name          = "leetcode-${each.key}"
  region        = each.key
  version       = data.digitalocean_kubernetes_versions.current.latest_version
  surge_upgrade = true

  # Connect the DigitalOcean Container Registry (created in Step 2) to this cluster.
  # DigitalOcean then copies a pull secret into the cluster's namespaces, so pods can pull
  # your images. The registry must already exist, or this apply fails.
  registry_integration = true

  # EDGE node pool: runs the judge. Grows from 2 to 4 nodes under load.
  node_pool {
    name       = "edge"
    size       = "s-2vcpu-4gb"
    auto_scale = true
    min_nodes  = 2
    max_nodes  = 4
    labels     = { pool = "edge" }
  }
}

# SANDBOX node pool: runs ONLY the runner (untrusted code). The taint keeps every
# other pod off these nodes, so a bad submission can't sit next to the judge.
resource "digitalocean_kubernetes_node_pool" "sandbox" {
  for_each   = digitalocean_kubernetes_cluster.leetcode
  cluster_id = each.value.id
  name       = "sandbox"
  size       = "s-2vcpu-4gb"
  auto_scale = true
  min_nodes  = 1
  max_nodes  = 3
  labels     = { pool = "sandbox" }

  taint {
    key    = "dedicated"
    value  = "sandbox"
    effect = "NoSchedule"
  }
}

output "clusters" {
  value = [for c in digitalocean_kubernetes_cluster.leetcode : c.name]
}
