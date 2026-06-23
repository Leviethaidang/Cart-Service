CREATE DATABASE IF NOT EXISTS ecommerce_cart_db;
USE ecommerce_cart_db;

CREATE TABLE IF NOT EXISTS carts (
    cart_id INT AUTO_INCREMENT PRIMARY KEY,
    user_id VARCHAR(128) NOT NULL UNIQUE,

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cart_items (
    cart_item_id INT AUTO_INCREMENT PRIMARY KEY,

    cart_id INT NOT NULL,
    product_id INT NOT NULL,
    variant_id INT NOT NULL,

    quantity INT NOT NULL DEFAULT 1,

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    UNIQUE KEY unique_cart_variant (cart_id, variant_id),

    INDEX idx_cart_id (cart_id),
    INDEX idx_product_id (product_id),
    INDEX idx_variant_id (variant_id),

    FOREIGN KEY (cart_id) REFERENCES carts(cart_id) ON DELETE CASCADE
);