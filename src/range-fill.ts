/** Keep the fill endpoint at the native 18px thumb's center, not value% of the outer box. */
export function syncRangeFill(input: HTMLInputElement): void {
 const min=Number(input.min),max=Number(input.max),value=Number(input.value);
 const fraction=max>min?Math.max(0,Math.min(1,(value-min)/(max-min))):0;
 input.style.setProperty('--range-fill', `calc(${fraction*100}% + ${9-18*fraction}px)`);
}
