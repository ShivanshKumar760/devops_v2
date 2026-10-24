variable "aws_region" {
  description = "AWS region to deploy into. Must be the region where Packer stored the AMI."
  type        = string
  default     = "ap-south-1"
}

variable "project_name" {
  description = "Prefix for every resource name (simple-vpc, simple-alb, simple-asg, ...)."
  type        = string
  default     = "simple"
}

variable "vpc_cidr" {
  description = "CIDR block of the VPC. Subnets are carved out of it as /24 blocks."
  type        = string
  default     = "10.0.0.0/16"
}

variable "az_count" {
  description = "Number of Availability Zones to use (this many public and this many private subnets)."
  type        = number
  default     = 2

  validation {
    condition     = var.az_count >= 2 && var.az_count <= 3
    error_message = "az_count must be 2 or 3 (the load balancer needs at least two AZs)."
  }
}

variable "enable_nat_gateway" {
  description = "Create NAT gateway(s) so private instances can reach the internet. The golden AMI needs no internet at runtime, so this is off by default. Turn it on if the app later calls external services (for example MongoDB Atlas)."
  type        = bool
  default     = false
}

variable "single_nat_gateway" {
  description = "Only used when enable_nat_gateway is true. true = one shared NAT gateway (cheaper). false = one per AZ (survives an AZ outage, costs more)."
  type        = bool
  default     = true
}

variable "create_asg" {
  description = "Create the launch template, Auto Scaling group and scaling policy. Set false to build only the network and load balancer (for example before running Packer in this VPC)."
  type        = bool
  default     = true
}



variable "ami_name_prefix" {
  description = "Name prefix of the AMIs built by Packer. The newest AMI in this account whose name starts with it is used."
  type        = string
  default     = "simple-api-ami"
}

variable "instance_type" {
  description = "EC2 instance type. Prefer t3 (t2 throttles CPU and distorts the load test)."
  type        = string
  default     = "t3.micro"
}

variable "min_size" {
  description = "Minimum number of instances."
  type        = number
  default     = 2
}

variable "max_size" {
  description = "Maximum number of instances."
  type        = number
  default     = 4
}

variable "desired_capacity" {
  description = "Initial number of instances (the scaling policy changes it afterwards)."
  type        = number
  default     = 2
}

variable "cpu_target" {
  description = "Target average CPU utilization (percent) for the target tracking scaling policy."
  type        = number
  default     = 60
}

variable "health_check_grace_seconds" {
  description = "Seconds the ASG waits after launch before counting load balancer health checks, and the scaling warmup."
  type        = number
  default     = 120
}

variable "app_name" {
  description = "Value written to APP_NAME in each instance's .env file."
  type        = string
  default     = "simple-asg-api"
}

variable "app_dir" {
  description = "Directory on the instance where Packer cloned the repository (Packer's app_dir)."
  type        = string
  default     = "/opt/simple-api"
}

variable "app_env" {
  description = "Extra settings written to each instance's .env file, for example MONGO_URI and JWT_SECRET. Marked sensitive so Terraform hides the values in plan output."
  type        = map(string)
  default     = {}
  sensitive   = true
}

variable "tags" {
  description = "Extra tags added to every resource."
  type        = map(string)
  default     = {}
}
