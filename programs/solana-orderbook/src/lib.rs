use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("HQNvupbQewUWSAS6WAxBakxhmKgF6YAXLpiXdSsQHq9K");

#[program]
pub mod solana_orderbook {
    use super::*;

    pub fn initialize_market(ctx: Context<InitializeMarket>) -> Result<()> {
        let market = &mut ctx.accounts.market;
        market.authority = ctx.accounts.authority.key();
        market.base_mint = ctx.accounts.base_mint.key();
        market.quote_mint = ctx.accounts.quote_mint.key();
        market.order_count = 0;
        market.bump = ctx.bumps.market;
        Ok(())
    }

    pub fn place_order(ctx: Context<PlaceOrder>, side: Side, price: u64, quantity: u64) -> Result<()> {
        require!(price > 0 && quantity > 0, OrderbookError::InvalidOrder);

        let deposit = match side {
            Side::Bid => price.checked_mul(quantity).ok_or(OrderbookError::Overflow)?,
            Side::Ask => quantity,
        };

        token::transfer(CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.user_token_account.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        ), deposit)?;

        let market = &mut ctx.accounts.market;
        let order_id = market.order_count;
        market.order_count = order_id.checked_add(1).ok_or(OrderbookError::Overflow)?;

        let order = &mut ctx.accounts.order;
        order.market = market.key();
        order.owner = ctx.accounts.owner.key();
        order.id = order_id;
        order.side = side;
        order.price = price;
        order.quantity = quantity;
        order.filled = 0;
        order.timestamp = Clock::get()?.unix_timestamp;
        order.bump = ctx.bumps.order;
        Ok(())
    }

    pub fn fill_order(ctx: Context<FillOrder>, fill_qty: u64) -> Result<()> {
        let order = &mut ctx.accounts.order;
        let remaining = order.quantity.checked_sub(order.filled).ok_or(OrderbookError::Overflow)?;
        require!(fill_qty > 0 && fill_qty <= remaining, OrderbookError::InvalidFill);

        let market = &ctx.accounts.market;
        let authority_key = market.authority;
        let base_key = market.base_mint;
        let quote_key = market.quote_mint;
        let bump = market.bump;
        let seeds: &[&[u8]] = &[b"market", authority_key.as_ref(), base_key.as_ref(), quote_key.as_ref(), &[bump]];

        match order.side {
            Side::Bid => {
                // Taker sends base tokens to order owner
                token::transfer(CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.taker_base.to_account_info(),
                        to: ctx.accounts.maker_base.to_account_info(),
                        authority: ctx.accounts.taker.to_account_info(),
                    },
                ), fill_qty)?;
                // Vault releases quote tokens to taker
                let quote_amount = order.price.checked_mul(fill_qty).ok_or(OrderbookError::Overflow)?;
                token::transfer(CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.taker_quote.to_account_info(),
                        authority: ctx.accounts.market.to_account_info(),
                    },
                    &[seeds],
                ), quote_amount)?;
            }
            Side::Ask => {
                // Taker sends quote tokens to order owner
                let quote_amount = order.price.checked_mul(fill_qty).ok_or(OrderbookError::Overflow)?;
                token::transfer(CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.taker_quote.to_account_info(),
                        to: ctx.accounts.maker_quote.to_account_info(),
                        authority: ctx.accounts.taker.to_account_info(),
                    },
                ), quote_amount)?;
                // Vault releases base tokens to taker
                token::transfer(CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.taker_base.to_account_info(),
                        authority: ctx.accounts.market.to_account_info(),
                    },
                    &[seeds],
                ), fill_qty)?;
            }
        }

        order.filled = order.filled.checked_add(fill_qty).ok_or(OrderbookError::Overflow)?;
        Ok(())
    }

    pub fn cancel_order(ctx: Context<CancelOrder>) -> Result<()> {
        let order = &ctx.accounts.order;
        let remaining = order.quantity.checked_sub(order.filled).ok_or(OrderbookError::Overflow)?;
        require!(remaining > 0, OrderbookError::AlreadyFilled);

        let market = &ctx.accounts.market;
        let authority_key = market.authority;
        let base_key = market.base_mint;
        let quote_key = market.quote_mint;
        let bump = market.bump;
        let seeds: &[&[u8]] = &[b"market", authority_key.as_ref(), base_key.as_ref(), quote_key.as_ref(), &[bump]];

        let refund = match order.side {
            Side::Bid => order.price.checked_mul(remaining).ok_or(OrderbookError::Overflow)?,
            Side::Ask => remaining,
        };

        token::transfer(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.owner_token_account.to_account_info(),
                authority: ctx.accounts.market.to_account_info(),
            },
            &[seeds],
        ), refund)?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializeMarket<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    pub base_mint: Account<'info, Mint>,
    pub quote_mint: Account<'info, Mint>,
    #[account(init, payer = authority, space = 8 + Market::INIT_SPACE,
        seeds = [b"market", authority.key().as_ref(), base_mint.key().as_ref(), quote_mint.key().as_ref()], bump)]
    pub market: Account<'info, Market>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PlaceOrder<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut)]
    pub market: Account<'info, Market>,
    #[account(init, payer = owner, space = 8 + Order::INIT_SPACE,
        seeds = [b"order", market.key().as_ref(), &market.order_count.to_le_bytes()], bump)]
    pub order: Account<'info, Order>,
    #[account(mut)]
    pub user_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FillOrder<'info> {
    #[account(mut)]
    pub taker: Signer<'info>,
    pub market: Account<'info, Market>,
    #[account(mut, has_one = market)]
    pub order: Account<'info, Order>,
    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub taker_base: Account<'info, TokenAccount>,
    #[account(mut)]
    pub taker_quote: Account<'info, TokenAccount>,
    #[account(mut)]
    pub maker_base: Account<'info, TokenAccount>,
    #[account(mut)]
    pub maker_quote: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CancelOrder<'info> {
    pub owner: Signer<'info>,
    pub market: Account<'info, Market>,
    #[account(mut, has_one = market, has_one = owner, close = owner)]
    pub order: Account<'info, Order>,
    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub owner_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[account]
#[derive(InitSpace)]
pub struct Market {
    pub authority: Pubkey,
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub order_count: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Order {
    pub market: Pubkey,
    pub owner: Pubkey,
    pub id: u64,
    pub side: Side,
    pub price: u64,
    pub quantity: u64,
    pub filled: u64,
    pub timestamp: i64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum Side {
    Bid,
    Ask,
}

#[error_code]
pub enum OrderbookError {
    #[msg("Invalid order parameters")]
    InvalidOrder,
    #[msg("Invalid fill quantity")]
    InvalidFill,
    #[msg("Order already fully filled")]
    AlreadyFilled,
    #[msg("Overflow")]
    Overflow,
}
