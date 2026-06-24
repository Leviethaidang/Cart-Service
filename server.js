require('dotenv').config();

const express = require('express');
const mysql = require('mysql2/promise');
const axios = require('axios');
const { CognitoJwtVerifier } = require('aws-jwt-verify');

const app = express();
app.use(express.json());

// 1. Cấu hình MySQL Pool
const dbPool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME, // ecommerce_cart_db
    waitForConnections: true,
    connectionLimit: 10
});

// 2. Cấu hình Cognito JWT Verifier
const verifier = CognitoJwtVerifier.create({
    userPoolId: process.env.COGNITO_USER_POOL_ID,
    tokenUse: "access",
    clientId: process.env.COGNITO_APP_CLIENT_ID
});

// 3. Helper validate số nguyên dương
function parsePositiveInteger(value) {
    const numberValue = Number(value);

    if (!Number.isInteger(numberValue) || numberValue <= 0) {
        return null;
    }

    return numberValue;
}

// 4. Helper lấy Product Service URL
function getProductServiceUrl() {
    const productServiceUrl = process.env.PRODUCT_SERVICE_URL;

    if (!productServiceUrl) {
        throw new Error("Thiếu PRODUCT_SERVICE_URL trong file .env");
    }

    return productServiceUrl.replace(/\/$/, '');
}

// 5. Helper gọi Product Service để lấy chi tiết sản phẩm
async function getProductById(productId) {
    try {
        const baseUrl = getProductServiceUrl();

        const response = await axios.get(`${baseUrl}/api/products/${productId}`, {
            timeout: 5000
        });

        return response.data.product;

    } catch (error) {
        if (error.response && error.response.status === 404) {
            return null;
        }

        console.error(
            "Lỗi gọi Product Service:",
            error.response?.data || error.message
        );

        throw new Error("Không thể kết nối Product Service!");
    }
}
// 6 Helper tìm variant trong product (nếu có)
function findVariant(product, variantId) {
    if (!product || !Array.isArray(product.variants)) {
        return null;
    }

    return product.variants.find(variant => {
        return Number(variant.variant_id) === Number(variantId);
    }) || null;
}

// 7. Helper lấy hoặc tạo cart cho user
async function getOrCreateCart(connection, userId) {
    await connection.execute(
        `
        INSERT INTO carts (user_id)
        VALUES (?)
        ON DUPLICATE KEY UPDATE user_id = user_id
        `,
        [userId]
    );

    const [rows] = await connection.execute(
        `
        SELECT cart_id, user_id, created_at, updated_at
        FROM carts
        WHERE user_id = ?
        `,
        [userId]
    );

    return rows[0];
}

// 8. Helper chỉ lấy cart, không tự tạo
async function getCartByUserId(connection, userId) {
    const [rows] = await connection.execute(
        `
        SELECT cart_id, user_id, created_at, updated_at
        FROM carts
        WHERE user_id = ?
        `,
        [userId]
    );

    return rows.length > 0 ? rows[0] : null;
}

function getInventoryServiceUrl() {
    const inventoryServiceUrl = process.env.INVENTORY_SERVICE_URL;

    if (!inventoryServiceUrl) {
        throw new Error("Thiếu INVENTORY_SERVICE_URL trong file .env");
    }

    return inventoryServiceUrl.replace(/\/$/, '');
}

async function getInventoryByVariantId(variantId) {
    try {
        const baseUrl = getInventoryServiceUrl();

        const response = await axios.get(`${baseUrl}/api/inventory/variants/${variantId}`, {
            timeout: 5000
        });

        return response.data.inventory;

    } catch (error) {
        if (error.response && error.response.status === 404) {
            return null;
        }

        console.error(
            "Lỗi gọi Inventory Service:",
            error.response?.data || error.message
        );

        throw new Error("Không thể kết nối Inventory Service!");
    }
}

async function getInventoryMapByVariantIds(variantIds) {
    const cleanVariantIds = [...new Set(
        (variantIds || [])
            .map(id => Number(id))
            .filter(id => Number.isInteger(id) && id > 0)
    )];

    if (cleanVariantIds.length === 0) {
        return new Map();
    }

    try {
        const baseUrl = getInventoryServiceUrl();

        const response = await axios.post(
            `${baseUrl}/api/inventory/variants/batch`,
            {
                variantIds: cleanVariantIds
            },
            {
                timeout: 5000
            }
        );

        const inventories = response.data.inventories || [];
        const inventoryMap = new Map();

        for (const inventory of inventories) {
            inventoryMap.set(Number(inventory.variant_id), inventory);
        }

        return inventoryMap;

    } catch (error) {
        console.error(
            "Lỗi gọi Inventory Service batch:",
            error.response?.data || error.message
        );

        throw new Error("Không thể kết nối Inventory Service!");
    }
}

// 9. Middleware xác thực
async function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({
            error: "Không tìm thấy Token. Vui lòng đăng nhập!"
        });
    }

    const token = authHeader.split(' ')[1];

    try {
        const payload = await verifier.verify(token);

        req.user = {
            sub: payload.sub,
            username: payload.username || payload["cognito:username"] || payload.sub,
            groups: payload["cognito:groups"] || [],
            accessToken: token
        };

        next();

    } catch (error) {
        console.error("Lỗi verify token tại Cart Service:", error);

        return res.status(401).json({
            error: "Token không hợp lệ hoặc đã hết hạn!"
        });
    }
}

// 10. Middleware xác thực API nội bộ
function internalMiddleware(req, res, next) {
    const internalApiKey = req.headers["x-internal-api-key"];

    if (!process.env.INTERNAL_API_KEY) {
        return res.status(500).json({
            error: "Cart Service chưa cấu hình INTERNAL_API_KEY!"
        });
    }

    if (internalApiKey !== process.env.INTERNAL_API_KEY) {
        return res.status(403).json({
            error: "Internal API key không hợp lệ!"
        });
    }

    next();
}

// =========================================================================
// ROUTE 1: THÊM SẢN PHẨM VÀO GIỎ HÀNG
// =========================================================================
app.post('/api/cart/items', authMiddleware, async (req, res) => {
    const userId = req.user.sub;

    const {
        productId,
        variantId,
        quantity = 1
    } = req.body || {};

    const parsedProductId = parsePositiveInteger(productId);
    const parsedVariantId = parsePositiveInteger(variantId);
    const parsedQuantity = parsePositiveInteger(quantity);

    if (!parsedProductId) {
        return res.status(400).json({
            error: "productId không hợp lệ!"
        });
    }

    if (!parsedVariantId) {
        return res.status(400).json({
            error: "variantId không hợp lệ!"
        });
    }

    if (!parsedQuantity) {
        return res.status(400).json({
            error: "quantity phải là số nguyên lớn hơn 0!"
        });
    }

    let connection;

    try {
        const product = await getProductById(parsedProductId);

        if (!product) {
            return res.status(404).json({
                error: "Sản phẩm không tồn tại!"
            });
        }

        const variant = findVariant(product, parsedVariantId);

        if (!variant) {
            return res.status(404).json({
                error: "Biến thể sản phẩm không tồn tại hoặc đã ngừng bán!"
            });
        }

        if (Number(variant.product_id) !== Number(product.product_id)) {
            return res.status(400).json({
                error: "Biến thể không thuộc sản phẩm này!"
            });
        }

        const inventory = await getInventoryByVariantId(parsedVariantId);

        if (!inventory) {
            return res.status(400).json({
                error: "Biến thể này chưa có tồn kho hoặc đã ngừng bán!"
            });
        }

        const availableQuantity = Number(inventory.quantity_available || 0);

        if (availableQuantity <= 0) {
            return res.status(400).json({
                error: "Biến thể này đã hết hàng!"
            });
        }

        connection = await dbPool.getConnection();
        await connection.beginTransaction();

        const cart = await getOrCreateCart(connection, userId);

        const [existingRows] = await connection.execute(
            `
            SELECT cart_item_id, quantity
            FROM cart_items
            WHERE cart_id = ? AND variant_id = ?
            FOR UPDATE
            `,
            [cart.cart_id, parsedVariantId]
        );

        const currentQuantity =
            existingRows.length > 0 ? Number(existingRows[0].quantity) : 0;

        const nextQuantity = currentQuantity + parsedQuantity;

        if (nextQuantity > availableQuantity) {
            await connection.rollback();

            return res.status(400).json({
                error: `Số lượng trong giỏ vượt quá tồn kho của biến thể. Tồn kho hiện tại: ${availableQuantity}`
            });
        }

        if (existingRows.length > 0) {
            await connection.execute(
                `
                UPDATE cart_items
                SET quantity = ?
                WHERE cart_id = ? AND variant_id = ?
                `,
                [nextQuantity, cart.cart_id, parsedVariantId]
            );
        } else {
            await connection.execute(
                `
                INSERT INTO cart_items (
                    cart_id,
                    product_id,
                    variant_id,
                    quantity
                )
                VALUES (?, ?, ?, ?)
                `,
                [
                    cart.cart_id,
                    parsedProductId,
                    parsedVariantId,
                    parsedQuantity
                ]
            );
        }

        await connection.commit();

        return res.status(201).json({
            message: "Đã thêm sản phẩm vào giỏ hàng!",
            item: {
                cartId: cart.cart_id,
                productId: parsedProductId,
                variantId: parsedVariantId,
                quantity: nextQuantity,
                product: {
                    productId: product.product_id,
                    productName: product.product_name,
                    categoryId: product.category_id,
                    categoryName: product.category_name,
                    description: product.description,
                    price: Number(product.price),
                    imageUrl: product.imageUrl
                },
                variant: {
                    variantId: variant.variant_id,
                    sizeId: variant.size_id,
                    sizeName: variant.size_name,
                    colorId: variant.color_id,
                    colorName: variant.color_name,
                    colorCode: variant.color_code,
                    quantityOnHand: Number(inventory.quantity_on_hand || 0),
                    quantityReserved: Number(inventory.quantity_reserved || 0),
                    quantityAvailable: availableQuantity
                }
            }
        });

    } catch (error) {
        if (connection) {
            await connection.rollback();
        }

        console.error("Lỗi thêm sản phẩm vào giỏ hàng:", error);

        return res.status(500).json({
            error: error.message || "Không thể thêm sản phẩm vào giỏ hàng!"
        });

    } finally {
        if (connection) connection.release();
    }
});

// =========================================================================
// ROUTE 2: XEM GIỎ HÀNG
// =========================================================================
app.get('/api/cart', authMiddleware, async (req, res) => {
    const userId = req.user.sub;

    let connection;

    try {
        connection = await dbPool.getConnection();

        const cart = await getCartByUserId(connection, userId);

        if (!cart) {
            return res.json({
                message: "Giỏ hàng đang trống!",
                cart: {
                    cartId: null,
                    userId,
                    totalQuantity: 0,
                    totalAmount: 0,
                    items: []
                }
            });
        }

        const [cartItemRows] = await connection.execute(
            `
            SELECT
                cart_item_id,
                cart_id,
                product_id,
                variant_id,
                quantity,
                created_at,
                updated_at
            FROM cart_items
            WHERE cart_id = ?
            ORDER BY updated_at DESC
            `,
            [cart.cart_id]
        );

        const variantIds = cartItemRows
            .map(item => item.variant_id)
            .filter(Boolean);

        const inventoryMap = await getInventoryMapByVariantIds(variantIds);

        const items = await Promise.all(
            cartItemRows.map(async (item) => {
                const product = await getProductById(item.product_id);

                if (!product) {
                    return {
                        cartItemId: item.cart_item_id,
                        productId: item.product_id,
                        variantId: item.variant_id,
                        quantity: item.quantity,
                        productDeleted: true,
                        variantDeleted: false,
                        inventoryMissing: true,
                        product: null,
                        variant: null,
                        subtotal: 0
                    };
                }

                const variant = findVariant(product, item.variant_id);

                if (!variant) {
                    return {
                        cartItemId: item.cart_item_id,
                        productId: item.product_id,
                        variantId: item.variant_id,
                        quantity: item.quantity,
                        productDeleted: false,
                        variantDeleted: true,
                        inventoryMissing: true,
                        product: {
                            productId: product.product_id,
                            productName: product.product_name,
                            categoryId: product.category_id,
                            categoryName: product.category_name,
                            price: Number(product.price),
                            imageUrl: product.imageUrl
                        },
                        variant: null,
                        subtotal: 0
                    };
                }

                const inventory = inventoryMap.get(Number(item.variant_id));
                const availableQuantity = Number(inventory?.quantity_available || 0);

                const price = Number(product.price);
                const subtotal = price * Number(item.quantity);

                return {
                    cartItemId: item.cart_item_id,
                    productId: item.product_id,
                    variantId: item.variant_id,
                    quantity: item.quantity,
                    productDeleted: false,
                    variantDeleted: false,
                    inventoryMissing: !inventory,
                    product: {
                        productId: product.product_id,
                        productName: product.product_name,
                        categoryId: product.category_id,
                        categoryName: product.category_name,
                        description: product.description,
                        price,
                        imageUrl: product.imageUrl
                    },
                    variant: {
                        variantId: variant.variant_id,
                        sizeId: variant.size_id,
                        sizeName: variant.size_name,
                        colorId: variant.color_id,
                        colorName: variant.color_name,
                        colorCode: variant.color_code,
                        quantityOnHand: Number(inventory?.quantity_on_hand || 0),
                        quantityReserved: Number(inventory?.quantity_reserved || 0),
                        quantityAvailable: availableQuantity
                    },
                    subtotal
                };
            })
        );

        const totalQuantity = items.reduce((sum, item) => {
            if (item.productDeleted || item.variantDeleted) {
                return sum;
            }

            return sum + Number(item.quantity || 0);
        }, 0);

        const totalAmount = items.reduce((sum, item) => {
            return sum + Number(item.subtotal || 0);
        }, 0);

        return res.json({
            message: "Lấy giỏ hàng thành công!",
            cart: {
                cartId: cart.cart_id,
                userId: cart.user_id,
                totalQuantity,
                totalAmount,
                items
            }
        });

    } catch (error) {
        console.error("Lỗi lấy giỏ hàng:", error);

        return res.status(500).json({
            error: error.message || "Không thể lấy giỏ hàng!"
        });

    } finally {
        if (connection) connection.release();
    }
});

// =========================================================================
// ROUTE 3: CẬP NHẬT SỐ LƯỢNG SẢN PHẨM TRONG GIỎ
// =========================================================================
app.put('/api/cart/items/:cartItemId', authMiddleware, async (req, res) => {
    const userId = req.user.sub;
    const { cartItemId } = req.params;
    const { quantity } = req.body || {};

    const parsedCartItemId = parsePositiveInteger(cartItemId);
    const parsedQuantity = parsePositiveInteger(quantity);

    if (!parsedCartItemId) {
        return res.status(400).json({
            error: "cartItemId không hợp lệ!"
        });
    }

    if (!parsedQuantity) {
        return res.status(400).json({
            error: "quantity phải là số nguyên lớn hơn 0!"
        });
    }

    let connection;

    try {
        connection = await dbPool.getConnection();

        const cart = await getCartByUserId(connection, userId);

        if (!cart) {
            return res.status(404).json({
                error: "Giỏ hàng chưa tồn tại!"
            });
        }

        const [itemRows] = await connection.execute(
            `
            SELECT
                cart_item_id,
                product_id,
                variant_id,
                quantity
            FROM cart_items
            WHERE cart_id = ? AND cart_item_id = ?
            `,
            [cart.cart_id, parsedCartItemId]
        );

        if (itemRows.length === 0) {
            return res.status(404).json({
                error: "Sản phẩm này chưa có trong giỏ hàng!"
            });
        }

        const item = itemRows[0];

        const product = await getProductById(item.product_id);

        if (!product) {
            return res.status(404).json({
                error: "Sản phẩm không tồn tại!"
            });
        }

        const variant = findVariant(product, item.variant_id);

        if (!variant) {
            return res.status(404).json({
                error: "Biến thể sản phẩm không tồn tại hoặc đã ngừng bán!"
            });
        }

        const inventory = await getInventoryByVariantId(item.variant_id);

        if (!inventory) {
            return res.status(400).json({
                error: "Biến thể này chưa có tồn kho hoặc đã ngừng bán!"
            });
        }

        const availableQuantity = Number(inventory.quantity_available || 0);

        if (parsedQuantity > availableQuantity) {
            return res.status(400).json({
                error: `Số lượng vượt quá số lượng còn lại của biến thể. Hiện tại còn: ${availableQuantity}`
            });
        }

        await connection.execute(
            `
            UPDATE cart_items
            SET quantity = ?
            WHERE cart_id = ? AND cart_item_id = ?
            `,
            [parsedQuantity, cart.cart_id, parsedCartItemId]
        );

        return res.json({
            message: "Cập nhật số lượng sản phẩm trong giỏ hàng thành công!",
            item: {
                cartId: cart.cart_id,
                cartItemId: parsedCartItemId,
                productId: item.product_id,
                variantId: item.variant_id,
                quantity: parsedQuantity,
                product: {
                    productId: product.product_id,
                    productName: product.product_name,
                    price: Number(product.price),
                    imageUrl: product.imageUrl
                },
                variant: {
                    variantId: variant.variant_id,
                    sizeId: variant.size_id,
                    sizeName: variant.size_name,
                    colorId: variant.color_id,
                    colorName: variant.color_name,
                    colorCode: variant.color_code,
                    quantityOnHand: Number(inventory.quantity_on_hand || 0),
                    quantityReserved: Number(inventory.quantity_reserved || 0),
                    quantityAvailable: availableQuantity
                }
            }
        });

    } catch (error) {
        console.error("Lỗi cập nhật giỏ hàng:", error);

        return res.status(500).json({
            error: error.message || "Không thể cập nhật giỏ hàng!"
        });

    } finally {
        if (connection) connection.release();
    }
});

// =========================================================================
// ROUTE 4: XÓA SẢN PHẨM KHỎI GIỎ
// =========================================================================
app.delete('/api/cart/items/:cartItemId', authMiddleware, async (req, res) => {
    const userId = req.user.sub;
    const { cartItemId } = req.params;

    const parsedCartItemId = parsePositiveInteger(cartItemId);

    if (!parsedCartItemId) {
        return res.status(400).json({
            error: "cartItemId không hợp lệ!"
        });
    }

    let connection;

    try {
        connection = await dbPool.getConnection();

        const cart = await getCartByUserId(connection, userId);

        if (!cart) {
            return res.status(404).json({
                error: "Giỏ hàng chưa tồn tại!"
            });
        }

        const [result] = await connection.execute(
            `
            DELETE FROM cart_items
            WHERE cart_id = ? AND cart_item_id = ?
            `,
            [cart.cart_id, parsedCartItemId]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({
                error: "Sản phẩm này không tồn tại trong giỏ hàng!"
            });
        }

        return res.json({
            message: "Đã xóa sản phẩm khỏi giỏ hàng!"
        });

    } catch (error) {
        console.error("Lỗi xóa sản phẩm khỏi giỏ hàng:", error);

        return res.status(500).json({
            error: "Không thể xóa sản phẩm khỏi giỏ hàng!"
        });

    } finally {
        if (connection) connection.release();
    }
});

// =========================================================================
// INTERNAL ROUTE: XÓA TOÀN BỘ GIỎ HÀNG CỦA USER SAU KHI ORDER THÀNH CÔNG
// =========================================================================
app.delete('/api/cart/internal/users/:userId', internalMiddleware, async (req, res) => {
    const { userId } = req.params;

    if (!userId) {
        return res.status(400).json({
            error: "Thiếu userId!"
        });
    }

    let connection;

    try {
        connection = await dbPool.getConnection();

        const cart = await getCartByUserId(connection, userId);

        if (!cart) {
            return res.json({
                message: "User chưa có cart, không cần dọn.",
                deletedItems: 0
            });
        }

        const [result] = await connection.execute(
            `
            DELETE FROM cart_items
            WHERE cart_id = ?
            `,
            [cart.cart_id]
        );

        return res.json({
            message: "Đã dọn giỏ hàng sau khi đặt hàng thành công.",
            cartId: cart.cart_id,
            deletedItems: result.affectedRows
        });

    } catch (error) {
        console.error("Lỗi dọn giỏ hàng internal:", error);

        return res.status(500).json({
            error: error.message || "Không thể dọn giỏ hàng!"
        });

    } finally {
        if (connection) connection.release();
    }
});

// Khởi chạy Cart Service ở cổng 3003
const PORT = process.env.PORT || 3003;

app.listen(PORT, () => {
    console.log(`Cart Service running on port ${PORT}`);
});