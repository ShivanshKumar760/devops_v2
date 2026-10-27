packer {
  required_plugins {
    amazon = {
      version = ">= 1.3.0"
      source  = "github.com/hashicorp/amazon"
    }
  }
}

variable "region" {
  type        = string
  default     = "ap-south-1"
  description = "Region to build and store the AMI in. Must match Terraform's aws_region."
}

variable "instance_type" {
  type        = string
  default     = "t3.micro"
  description = "Instance type of the temporary build instance."
}

variable "ami_name_prefix" {
  type        = string
  default     = "simple-api-ami"
  description = "AMIs are named <prefix>-<timestamp>. Must match Terraform's ami_name_prefix."
}

variable "repo_url" {
  type        = string
  description = "HTTPS clone URL of the app repository, for example https://github.com/you/simple-asg-api.git"
}

variable "repo_branch" {
  type    = string
  default = "master"
}

variable "github_token" {
  type        = string
  default     = ""
  sensitive   = true
  description = "Only for PRIVATE repositories: a read-only token. Leave empty for public repositories."
}

variable "vpc_id" {
  type        = string
  default     = ""
  description = "Optional. Only needed if the account has no default VPC."
}

variable "subnet_id" {
  type        = string
  default     = ""
  description = "Optional. A PUBLIC subnet (one that auto-assigns public IPs), needed together with vpc_id."
}

variable "app_dir" {
  type        = string
  default     = "/opt/simple-api"
  description = "Directory on the instance where the repository is cloned. Must match the cwd in the repo's ecosystem.config.cjs and Terraform's app_dir."
}

variable "smoke_test" {
  type        = bool
  default     = true
  description = "Start the app during the build and curl /health and /load. Set false for apps that need a database or secrets to start (for example the banking API)."
}

locals {
  timestamp = formatdate("YYYYMMDD-hhmmss", timestamp())
}

source "amazon-ebs" "simple_api" {
  region          = var.region
  instance_type   = var.instance_type
  ami_name        = "${var.ami_name_prefix}-${local.timestamp}"
  ami_description = "Ubuntu 24.04 + Node 22 + PM2 + simple-asg-api (built by Packer)"
  source_ami_filter {
    filters = {
      name                = "ubuntu/images/hvm-ssd*/ubuntu-noble-24.04-amd64-server-*"
      root-device-type    = "ebs"
      virtualization-type = "hvm"
    }
    owners      = ["099720109477"]
    most_recent = true
  }
  # Networking for the temporary build instance (empty values = use the default VPC)
  vpc_id                                    = var.vpc_id
  subnet_id                                 = var.subnet_id
  associate_public_ip_address               = true
  ssh_username                              = "ubuntu"
  ssh_clear_authorized_keys                 = true
  temporary_security_group_source_public_ip = true

  tags = {
    Name    = "${var.ami_name_prefix}-${local.timestamp}"
    BuiltBy = "packer"
    Project = "simple-asg-api"
  }
  snapshot_tags = {
    Name    = "${var.ami_name_prefix}-${local.timestamp}"
    BuiltBy = "packer"
  }
  run_tags = {
    Name = "packer-build-${var.ami_name_prefix}"
  }
}

build {
  name    = "simple-api"
  sources = ["source.amazon-ebs.simple_api"]
  provisioner "shell" {
    script = "${path.root}/provision.sh"
    environment_vars = [
      "REPO_URL=${var.repo_url}",
      "BRANCH=${var.repo_branch}",
      "GITHUB_TOKEN=${var.github_token}",
      "APP_DIR=${var.app_dir}",
      "SMOKE_TEST=${var.smoke_test}",
    ]
    # run as root, keeping the variables above
    execute_command = "chmod +x {{ .Path }}; {{ .Vars }} sudo -E {{ .Path }}"
  }

  # Writes manifest.json with the new AMI ID
  post-processor "manifest" {
    output     = "manifest.json"
    strip_path = true
  }

}