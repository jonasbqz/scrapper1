# Frontend Premium Plan Implementation Guide

This document provides instructions for the frontend team to integrate the new **Premium Subscription** functionality.

## 1. Checking the User's Plan
The backend updates the user profile when they authenticate or fetch their profile. Look out for the following properties in the `profile` object:
- `plan`: A string that can be either `'basic'` or `'premium'`.
- `premiumExpireAt`: A timestamp string indicating when the premium subscription expires.

> [!IMPORTANT]
> A user is considered premium if:
> `user.profile.plan === 'premium'` AND `new Date(user.profile.premiumExpireAt) > new Date()`

## 2. Premium Benefits
As requested, you should unlock the following benefits for users who have an active Premium plan:

1. **No Intrusive Ads**: Hide all banner, pop-up, or native advertisements across the site.
2. **More Download Access**: Allow unlimited (or expanded limit) downloads. Check the premium status before restricting downloads.
3. **Access to 5,000+ Comics & Mangas**: Unblock premium-only reading material or provide higher priority.
4. **Priority Customer Support**: Show a special support channel or prioritize their tickets in the UI.
5. **Premium Badge**: Display a "Premium" label, icon, or special colored border around the user's avatar in comments and profile pages.
6. **Image Comments**: Allow the user to upload or attach images when posting a comment (hide the image upload button for basic users).

## 3. Purchasing Premium
To allow users to buy the premium plan, create a "Upgrade to Premium" button and screen.

When the user clicks the "Buy for $2.44" button:
1. Make a `POST` request to the backend: `/payment/checkout`
2. No body is required. The backend will use the logged-in user's authentication token to identify the profile.
3. The response will look like this:
   ```json
   {
     "url": "https://pay.cryptomus.com/pay/...",
     "orderId": "premium_123_1680000000"
   }
   ```
4. Immediately redirect the user's browser to the `url` returned in the response.

## 4. Successful Payment Callback
After completing the payment on Cryptomus, the user will be redirected back to the frontend URL defined as `url_return` in the backend service (typically `/premium/success`).

- Show a success message like: "¡Felicidades! Ahora eres Premium."
- Fetch the user's profile data again to refresh their `plan` and `premiumExpireAt` status on the client-side.
