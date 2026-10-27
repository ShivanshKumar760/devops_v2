variable "aws_region" {
  description = "AWS region to deploy into."
  type        = string
  default     = "ap-south-1"
}

variable "project_name" {
  description = "Prefix for the names of all resources (blog-vpc, blog-alb, ...)."
  type        = string
  default     = "blog"
}

variable "vpc_cidr" {
  description = "IP range of the VPC. The subnets are /24 blocks carved out of it, so use a /16 (or larger)."
  type        = string
  default     = "10.0.0.0/16"

  validation {
    condition     = can(regex("^[0-9]{1,3}([.][0-9]{1,3}){3}/(8|9|1[0-6])$", var.vpc_cidr))
    error_message = "vpc_cidr must look like 10.0.0.0/16 (a prefix length between /8 and /16)."
  }
}

variable "app_port" {
  description = "Port the Node.js API listens on. Used by the app, the target group and the security group."
  type        = number
  default     = 3000

  validation {
    condition     = var.app_port >= 1024 && var.app_port <= 65535
    error_message = "app_port must be between 1024 and 65535."
  }
}

variable "instance_type" {
  description = "EC2 instance type. t3 is recommended, t2 throttles the CPU during load tests."
  type        = string
  default     = "t3.micro"
}

variable "mongodb_uri" {
  description = "MongoDB Atlas connection string, including the database name. No default: you must supply it."
  type        = string
  sensitive   = true

  validation {
    condition     = startswith(var.mongodb_uri, "mongodb")
    error_message = "mongodb_uri must start with mongodb:// or mongodb+srv://."
  }
}

variable "jwt_secret" {
  description = "Secret used to sign JWTs. Use at least 32 random characters (openssl rand -base64 48)."
  type        = string
  sensitive   = true

  validation {
    condition     = length(var.jwt_secret) >= 32
    error_message = "jwt_secret must be at least 32 characters long."
  }
}

variable "jwt_expires_in" {
  description = "How long a login token stays valid (for example 15m, 1h, 7d)."
  type        = string
  default     = "1h"
}

variable "tags" {
  description = "Extra tags added to every resource."
  type        = map(string)
  default     = {}
}

variable "repo_url" {
  description = "The HTTP Git URL of your blog-api repository."
  type        = string
  default     = "https://github.com/ShivanshKumar760/load-test-blog-api.git" # Replace with your real repo URL
}
