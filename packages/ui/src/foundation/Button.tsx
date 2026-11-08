import { forwardRef, type ComponentPropsWithoutRef } from 'react'

export interface ButtonProps extends ComponentPropsWithoutRef<'button'> {
  variant?: 'primary' | 'outline'
}

/** 旧版主按钮和次按钮；未指定 type 时沿用原生 button 行为。 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', className, ...props }, ref,
) {
  return <button {...props} ref={ref} data-xunjie-button="" className={[variant, className].filter(Boolean).join(' ')} />
})
