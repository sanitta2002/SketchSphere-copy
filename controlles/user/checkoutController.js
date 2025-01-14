const Cart = require('../../models/cartSchema');
const Order = require('../../models/orderSchema');
const Address = require('../../models/addressSchema');
const Coupon = require('../../models/couponSchema');
const CouponUsage = require('../../models/couponUsageSchema');
const User = require('../../models/userSchema');
const Product = require('../../models/productSchema');
const mongoose = require('mongoose');

const checkoutController = {
    loadCheckout: async (req, res) => {
        try {
            if (!req.session.user) {
                return res.redirect('/login');
            }

            const user = await User.findById(req.session.user);
            const cart = await Cart.findOne({ userId: req.session.user })
                .populate('items.productId', 'name product_img Sale_price available_quantity offerPrice offerPercentage offerStartDate offerEndDate');

            if (!cart || !cart.items || cart.items.length === 0) {
                return res.redirect('/cart');
            }

            // Calculate prices with offers
            cart.items = cart.items.map(item => {
                const hasValidOffer = item.productId.offerPrice > 0 && 
                                   new Date(item.productId.offerEndDate) > new Date();
                item.currentPrice = hasValidOffer ? item.productId.offerPrice : item.productId.Sale_price;
                item.totalPrice = item.currentPrice * item.quantity;
                return item;
            });

            // Calculate cart total with offers
            const totalPrice = cart.items.reduce((total, item) => {
                return total + item.totalPrice;
            }, 0);

            const userAddress = await Address.findOne({ userId: req.session.user });
            const addresses = userAddress ? userAddress.address : [];

            // Get used coupons from CouponUsage
            const usedCoupons = await CouponUsage.distinct('couponCode', { 
                userId: req.session.user 
            });

            // Get all active coupons
            const allActiveCoupons = await Coupon.find({
                isList: true,
                expireOn: { $gt: new Date() },
                minimumPrice: { $lte: totalPrice }
            });

            // Filter out used coupons
            const activeCoupons = allActiveCoupons.filter(coupon => 
                !usedCoupons.includes(coupon.name.toUpperCase())
            );

            res.render('checkout', {
                cart,
                addresses,
                totalPrice,
                activeCoupons,
                pageTitle: 'Checkout',
                user
            });
        } catch (error) {
            console.error('Error loading checkout:', error);
            res.status(500).render('error', { error: 'Failed to load checkout page' });
        }
    },

    applyCoupon: async (req, res) => {
        try {
            const { couponCode, totalAmount } = req.body;
            const userId = req.session.user;

            // Check if user already has an active coupon in their current checkout session
            if (req.session.appliedCoupon) {
                return res.json({
                    success: false,
                    message: 'A coupon is already applied. Please remove it first to apply a different coupon.'
                });
            }

            const coupon = await Coupon.findOne({
                name: couponCode.toUpperCase(),
                isList: true,
                expireOn: { $gt: new Date() }
            });

            if (!coupon) {
                return res.json({
                    success: false,
                    message: 'Invalid or expired coupon code'
                });
            }

            if (totalAmount < coupon.minimumPrice) {
                return res.json({
                    success: false,
                    message: `Minimum purchase amount of ₹${coupon.minimumPrice} required`
                });
            }

            // Check if coupon has been used before
            const couponUsage = await CouponUsage.findOne({
                userId,
                couponCode: couponCode.toUpperCase()
            });

            if (couponUsage) {
                return res.json({
                    success: false,
                    message: 'You have already used this coupon before'
                });
            }

            const discount = Math.min(coupon.offerPrice, totalAmount);

            // Store the applied coupon in session
            req.session.appliedCoupon = {
                code: coupon.name,
                discount: discount,
                couponId: coupon._id
            };

            return res.json({
                success: true,
                message: 'Coupon applied successfully!',
                discount,
                couponId: coupon._id
            });

        } catch (error) {
            console.error('Error applying coupon:', error);
            return res.json({
                success: false,
                message: 'Failed to apply coupon'
            });
        }
    },

    removeCoupon: async (req, res) => {
        try {
            // Remove the applied coupon from session
            delete req.session.appliedCoupon;
            
            return res.json({
                success: true,
                message: 'Coupon removed successfully'
            });
        } catch (error) {
            console.error('Error removing coupon:', error);
            return res.json({
                success: false,
                message: 'Failed to remove coupon'
            });
        }
    },

    placeOrder: async (req, res) => {
        try {
            const { 
                addressId, 
                paymentMethod, 
                couponCode, 
                totalPrice,
                finalAmount,
                razorpay_payment_id,
                razorpay_order_id,
                razorpay_signature
            } = req.body;

            // Validate required fields
            if (!totalPrice || !finalAmount) {
                return res.status(400).json({
                    success: false,
                    message: 'Total price and final amount are required'
                });
            }

            // Validate address
            const userAddress = await Address.findOne({ 
                userId: req.session.user,
                'address._id': addressId 
            });

            if (!userAddress) {
                return res.status(400).json({ 
                    success: false, 
                    message: 'Invalid address selected' 
                });
            }

            // Get cart items first
            const cart = await Cart.findOne({ userId: req.session.user })
                .populate('items.productId', 'name Sale_price available_quantity offerPrice offerPercentage offerStartDate offerEndDate');

            if (!cart || !cart.items || cart.items.length === 0) {
                return res.status(400).json({
                    success: false,
                    message: 'Cart is empty'
                });
            }

            // Calculate final prices with offers
            const orderItems = cart.items.map(item => {
                const hasValidOffer = item.productId.offerPrice > 0 && 
                                   new Date(item.productId.offerEndDate) > new Date();
                const price = hasValidOffer ? item.productId.offerPrice : item.productId.Sale_price;
                return {
                    product: item.productId._id,
                    quantity: item.quantity,
                    price: price,
                    totalPrice: price * item.quantity
                };
            });

            // Calculate order total
            const orderTotal = orderItems.reduce((total, item) => total + item.totalPrice, 0);

            // Validate product quantities
            for (const cartItem of cart.items) {
                const product = await Product.findById(cartItem.productId._id);
                if (!product) {
                    return res.status(400).json({
                        success: false,
                        message: `Product ${cartItem.productId.name} not found`
                    });
                }
                if (product.available_quantity < cartItem.quantity) {
                    return res.status(400).json({
                        success: false,
                        message: `Insufficient stock for ${product.name}. Only ${product.available_quantity} available.`
                    });
                }
            }

            // Create order
            const order = new Order({
                userId: req.session.user,
                orderedItems: orderItems,
                address: userAddress.address.find(addr => addr._id.toString() === addressId),
                paymentMethod: paymentMethod,
                totalPrice: totalPrice,
                finalAmount: finalAmount,
                paymentStatus: paymentMethod === 'online' ? 'Processing' : 'Pending',
                status: 'Pending',
                couponCode: couponCode || null
            });

            // If online payment, add payment details
            if (paymentMethod === 'online') {
                if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature) {
                    console.error('Missing payment details:', { razorpay_payment_id, razorpay_order_id, razorpay_signature });
                    return res.status(400).json({
                        success: false,
                        message: 'Payment information missing'
                    });
                }
                order.paymentDetails = {
                    razorpay_payment_id,
                    razorpay_order_id,
                    razorpay_signature
                };
            }

            console.log('Saving order with items:', order);
            await order.save();

            // Update product quantities
            const updatePromises = cart.items.map(async (item) => {
                console.log(`Updating quantity for product ${item.productId._id} by -${item.quantity}`);
                return Product.findByIdAndUpdate(
                    item.productId._id,
                    { $inc: { available_quantity: -item.quantity } },
                    { new: true }
                );
            });

            try {
                const updatedProducts = await Promise.all(updatePromises);
                console.log('Updated product quantities:', updatedProducts.map(p => ({
                    id: p._id,
                    name: p.name,
                    newQuantity: p.available_quantity
                })));
            } catch (error) {
                console.error('Error updating product quantities:', error);
                // Don't fail the order if quantity update fails
                // But log it for investigation
            }

            // Clear cart only for COD orders (online orders clear cart after payment verification)
            if (paymentMethod === 'COD') {
                await Cart.findOneAndUpdate(
                    { userId: req.session.user },
                    { $set: { items: [] } }
                );
            }

            // If there was a coupon used, record it
            if (couponCode) {
                await CouponUsage.create({
                    userId: req.session.user,
                    couponCode: couponCode.toUpperCase(),
                    usedAt: new Date()
                });
                // Clear the applied coupon from session
                delete req.session.appliedCoupon;
            }

            res.json({
                success: true,
                orderId: order._id,
                message: 'Order placed successfully'
            });

        } catch (error) {
            console.error('Error placing order:', error);
            res.status(500).json({
                success: false,
                message: error.message || 'Failed to place order'
            });
        }
    }
};

module.exports = checkoutController;
