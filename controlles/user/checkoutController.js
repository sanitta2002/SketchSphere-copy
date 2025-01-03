const Cart = require('../../models/cartSchema');
const Order = require('../../models/orderSchema');
const Address = require('../../models/addressSchema');
const mongoose = require('mongoose');

const checkoutController = {
    loadCheckout: async (req, res) => {
        try {
            if (!req.session.user) {
                return res.redirect('/login');
            }

            const cart = await Cart.findOne({ userId: req.session.user })
                .populate('items.productId', 'name product_img Sale_price');

            if (!cart || !cart.items || cart.items.length === 0) {
                return res.redirect('/cart');
            }

            
            const totalPrice = cart.items.reduce((total, item) => { // Calculate total price
                return total + (item.quantity * item.productId.Sale_price);
            }, 0);

            
            const userAddress = await Address.findOne({ userId: req.session.user });  // Fetch user addresses
            const addresses = userAddress ? userAddress.address : []; 

            res.render('checkout', { 
                cart, 
                addresses,
                totalPrice,
                pageTitle: 'Checkout'
            });
        } catch (error) {
            console.error('Error loading checkout:', error);
            res.status(500).render('error', { error: 'Failed to load checkout page' });
        }
    },

    placeOrder: async (req, res) => {
        try {
            if (!req.session.user) {
                return res.status(401).json({ success: false, message: 'Please login first' });
            }

            const { addressId, paymentMethod } = req.body;
            console.log('Placing order with:', {
                userId: req.session.user,
                addressId,
                paymentMethod
            });

            
            const address = await Address.findOne({ userId: req.session.user });// Find user address document
            if (!address) {
                console.error('No address found for user:', req.session.user);
                return res.status(400).json({ success: false, message: 'No address found' });
            }

            
            const selectedAddress = address.address.find(addr => addr._id.toString() === addressId); // Find the specific address from the array
            if (!selectedAddress) {
                console.error('Selected address not found:', addressId);
                return res.status(400).json({ success: false, message: 'Selected address not found' });
            }

            const cart = await Cart.findOne({ userId: req.session.user })
                .populate('items.productId');

            if (!cart || !cart.items || cart.items.length === 0) {
                console.error('Cart is empty for user:', req.session.user);
                return res.status(400).json({ success: false, message: 'Cart is empty' });
            }

            
            const orderedItems = cart.items.map(item => ({    // Create order items
                product: item.productId._id,
                quantity: item.quantity,
                price: item.productId.Sale_price
            }));

            // Calculate total price
            const totalPrice = orderedItems.reduce((total, item) => {
                return total + (item.quantity * item.price);
            }, 0);

            // Convert string ID to ObjectId
            const userId = new mongoose.Types.ObjectId(req.session.user);

            // Update product quantities
            for (const item of cart.items) {
                const product = item.productId;
                const newQuantity = product.available_quantity - item.quantity;
                
                if (newQuantity < 0) {
                    return res.status(400).json({ 
                        success: false, 
                        message: `Not enough stock available for ${product.name}` 
                    });
                }
                
                await mongoose.model('Product').findByIdAndUpdate(
                    product._id,
                    { $set: { available_quantity: newQuantity } }
                );
            }

            // Create new order
            const order = new Order({
                userId: userId,
                orderedItems,
                totalPrice,
                finalAmount: totalPrice,
                address: {
                    addressType: selectedAddress.addressType,
                    name: selectedAddress.name,
                    city: selectedAddress.city,
                    landMark: selectedAddress.landMark,
                    state: selectedAddress.state,
                    pincode: selectedAddress.pincode,
                    phone: selectedAddress.phone
                },
                status: 'Pending',
                createdOn: new Date(),
                paymentMethod,
                paymentStatus: paymentMethod === 'COD' ? 'Pending' : 'Processing'
            });

            console.log('Saving order:', {
                userId: order.userId.toString(),
                totalPrice: order.totalPrice,
                address: order.address,
                items: order.orderedItems.length,
                status: order.status,
                paymentMethod: order.paymentMethod,
                paymentStatus: order.paymentStatus
            });

            // Save the order
            const savedOrder = await order.save();
            console.log('Order saved successfully with ID:', savedOrder._id);

            // Verify the order was saved
            const verifyOrder = await Order.findById(savedOrder._id);
            if (!verifyOrder) {
                console.error('Failed to verify saved order');
                throw new Error('Order verification failed');
            }
            console.log('Order verified in database');

            // Clear cart
            cart.items = [];
            await cart.save();
            console.log('Cart cleared successfully');

            // Return success with redirect URL
            res.json({ 
                success: true, 
                message: 'Order placed successfully',
                redirectUrl: '/orders'
            });

        } catch (error) {
            console.error('Error placing order:', error);
            res.status(500).json({ success: false, message: 'Failed to place order' });
        }
    }
};

module.exports = checkoutController;
