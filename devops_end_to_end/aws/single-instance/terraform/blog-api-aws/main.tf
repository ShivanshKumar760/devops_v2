terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws ={
        source = "hashicorp/aws"
        version = "~> 5.0"
    }
  }
}


provider "aws" {
  region = var.aws_region
  default_tags {
    tags = merge({Project = var.project_name , ManagedBy = "terraform"}, var.tags)
  }
}

data "aws_availability_zones" "available" {
  state = "available"
}

data "aws_ami" "ubuntu" {
  most_recent = true
  owners = ["099720109477"]
  filter{
    name = "name"
    values = ["ubuntu/images/hvm-ssd*/ubuntu-noble-24.04-amd64-server-*"]
  }
  filter {
    name = "virtualization-type"
    values = ["hvm"]
  }
}

locals {
  name = var.project_name
  azs = slice(data.aws_availability_zones.available.names, 0, 2)
  public_subnet_cidr = [for i in range(2):cidrsubnet(var.vpc_cidr,8,i+1)]
  private_subnet_cidr = [for i in range(2):cidrsubnet(var.vpc_cidr,8,i+11)]
  server_js_b64 = base64encode(file("${path.module}/server.js"))

  user_data = <<-EOT
    #!/bin/bash
    set -euo pipefail
    export DEBIAN_FRONTEND=noninteractive
    export HOME=/root

    # 1) Install Node.js 22
    apt-get -o DPkg::Lock::Timeout=300 update -y
    apt-get -o DPkg::Lock::Timeout=300 install -y curl ca-certificates gnupg git
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get -o DPkg::Lock::Timeout=300 install -y nodejs

    # 2) Clone application from GitHub instead of embedding base64
    APP_DIR=/opt/blog-api
    rm -rf "$APP_DIR"
    git clone "${var.repo_url}" "$APP_DIR"
    cd "$APP_DIR"

    # Install dependencies cleanly
    npm install --omit=dev

    # 3) Settings and secrets
    cat > .env <<'EOF'
    PORT=${var.app_port}
    NODE_ENV=production
    MONGODB_URI=${var.mongodb_uri}
    JWT_SECRET=${var.jwt_secret}
    JWT_EXPIRES_IN=${var.jwt_expires_in}
    EOF
    chmod 600 .env

    # 4) Run the app as a systemd service
    cat > /etc/systemd/system/blog-api.service <<'EOF'
    [Unit]
    Description=Blog API
    After=network-online.target
    Wants=network-online.target

    [Service]
    WorkingDirectory=/opt/blog-api
    EnvironmentFile=/opt/blog-api/.env
    ExecStart=/usr/bin/node server.js  # 💡 Change index.js to server.js if your entrypoint file is named server.js
    Restart=always
    RestartSec=5

    [Install]
    WantedBy=multi-user.target
    EOF

    systemctl daemon-reload
    systemctl enable --now blog-api
EOT
}


resource "aws_vpc" "this" {
  cidr_block = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support = true

  tags = {Name="${local.name}-vpc"}
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags = {Name="${local.name}-igw"}
}

resource "aws_subnet" "public" {
  count = 2
  vpc_id = aws_vpc.this.id
  availability_zone = local.azs[count.index]
  cidr_block = local.public_subnet_cidr[count.index]
  map_public_ip_on_launch = true

  tags = {
    Name = "${local.name}-public-${substr(local.azs[count.index],-1,-1)}"
    Tier = "public"
  }
}

resource "aws_subnet" "private" {
  count = 2
  vpc_id = aws_vpc.this.id
  availability_zone = local.azs[count.index]
  cidr_block = local.private_subnet_cidr[count.index]
  map_public_ip_on_launch = false 
  tags = {
    Name = "${local.name}-private-${substr(local.azs[count.index], -1, -1)}"
    Tier = "private"
  }
}

#Creating route table first 

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  tags = { Name = "${local.name}-rtb-public" }
}

#adding the routing path to reach internet via aws igw
resource "aws_route" "public_internet" {
  route_table_id = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id = aws_internet_gateway.this.id
}

#Associating the route table with the public subnet in the vpc

resource "aws_route_table_association" "public" {
  count = 2
  subnet_id = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

#NAT gateway : lives in a. public subnet ans has fixed ip (an elastic ip)
resource "aws_eip" "nat" {
  domain = "vpc"
  tags = {Name = "${local.name}-nat-eip"}
  depends_on = [ aws_internet_gateway.this ]
}

resource "aws_nat_gateway" "this" {
  allocation_id = aws_eip.nat.id
  subnet_id = aws_subnet.public[0].id

  tags = { Name = "${local.name}-nat" }
  depends_on = [ aws_internet_gateway.this ]
}

#Private route table :
resource "aws_route_table" "private" {
  vpc_id = aws_vpc.this.id 
  tags = {Name="${local.name}-rtb-private"}
}

#Route table - routing rule all the traffic from private network 
#like ec2 trying to download something from internet will first reach to 
#Nat gateway then nat gateway will change the request payload with its ip
#and use the public route table route to send request to internet via igw

resource "aws_route" "private_nat" {
  route_table_id = aws_route_table.private.id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id = aws_nat_gateway.this.id 
}


#Associating the route table with the private subnet
resource "aws_route_table_association" "private" {
  count = 2
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

############################################################
# 6. Security groups: the firewalls
############################################################
resource "aws_security_group" "alb" {
  name = "${local.name}-alb-sg"
  description = "Load balancer: HTTP from the internet"
  vpc_id = aws_vpc.this.id

  ingress {
    description = "HTTP from anywhere"
    from_port = 80
    to_port = 80
    protocol = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
    ipv6_cidr_blocks = ["::/0"]
  }

  egress {
    description = "All outbound"
    from_port = 0
    to_port = 0
    protocol = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${local.name}-alb-sg" }
}


resource "aws_security_group" "app" {

    name = "${local.name}-app-sg"
    description = "EC2 instance: app port from the load balancer only"
    vpc_id = aws_vpc.this.id

    ingress {
        description = "App port from the load balancer security group"

        from_port = var.app_port
        to_port = var.app_port
        protocol = "tcp"
        security_groups = [aws_security_group.alb.id]
    }

    egress {
    description = "All outbound (package downloads and MongoDB Atlas go out through the NAT gateway)"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
    }

    tags = { Name = "${local.name}-app-sg" }
}


############################################################
# 7. Application Load Balancer in the public subnets
############################################################


resource "aws_lb" "app" {
    name = "${local.name}-alb"
    load_balancer_type = "application"
    internal = false 
    security_groups = [aws_security_group.alb.id]
    subnets = aws_subnet.public[*].id
    tags = { Name = "${local.name}-alb" }
}

resource "aws_lb_target_group" "app" {
  name = "${local.name}-tg"
  port = var.app_port
  protocol = "HTTP"
  vpc_id = aws_vpc.this.id
  target_type = "instance"
  deregistration_delay = 30

  health_check {
    path = "/health"
    matcher = "200"
    interval = 15
    timeout = 5
    healthy_threshold = 2
    unhealthy_threshold = 3
  }
  tags = { Name = "${local.name}-tg" }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.app.arn
  port = 80
  protocol = "HTTP"

  default_action {
    type = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }
}

# Registers the EC2 instance in the target group
resource "aws_lb_target_group_attachment" "app" {
    target_group_arn = aws_lb_target_group.app.arn
    target_id = aws_instance.app.id
    port = var.app_port
    depends_on = [ aws_instance.app ]
}


############################################################
# 8. The EC2 instance, in a PRIVATE subnet
############################################################

resource "aws_instance" "app" {
  ami                         = data.aws_ami.ubuntu.id
  instance_type               = var.instance_type
  subnet_id                   = aws_subnet.private[0].id
  vpc_security_group_ids      = [aws_security_group.app.id]
  user_data                   = local.user_data
  user_data_replace_on_change = true # a new user_data (or new server.js) replaces the instance

  # IMDSv2 only
  metadata_options {
    http_tokens = "required"
  }

  root_block_device {
    volume_type = "gp3"
    volume_size = 12
    encrypted   = true
  }

  tags = { Name = "${local.name}-api" }

  # The boot script downloads packages, so the private route to the NAT gateway must exist BEFORE the instance starts.
  # Nothing in this resource references the route, so Terraform cannot work that out alone.
  depends_on = [aws_route.private_nat, aws_route_table_association.private]

  lifecycle {
    precondition {
      condition     = length(local.user_data) <= 16000
      error_message = "user_data is bigger than the 16 KB EC2 limit. Make server.js smaller, or download it from GitHub instead of embedding it."
    }
  }
}